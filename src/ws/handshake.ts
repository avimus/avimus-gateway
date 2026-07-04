import type { IncomingMessage } from "node:http";
import { verifyToken, TokenValidationError, type GatewayTokenPayload } from "../auth/verifyToken";
import type { RevocationList } from "../auth/revocationList";
import { isCompatibleProtocolVersion } from "./protocolVersion";
import { MAX_CONNECTIONS_PER_TENANT, type ConnectionRegistry } from "./connectionRegistry";
import type { AvimusClient } from "../avimus-client/client";

const OPAQUE_TOKEN_PREFIX = "hst_";

export interface HandshakeDeps {
  jwtSecret: string;
  revocationList: RevocationList;
  isProduction: boolean;
  registry: ConnectionRegistry;
  avimusClient: AvimusClient;
}

export interface AuthenticatedRequest extends IncomingMessage {
  gatewayAuth?: GatewayTokenPayload;
}

type VerifyClientCallback = (result: boolean, code?: number, message?: string) => void;
type VerifyClientInfo = { origin: string; secure: boolean; req: IncomingMessage };

/** Requests are secure if terminated with TLS here, or upstream by a reverse proxy that sets this header. */
function isSecureRequest(req: IncomingMessage, secureAtThisSocket: boolean): boolean {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string") {
    return forwardedProto.split(",")[0]?.trim() === "https";
  }
  return secureAtThisSocket;
}

/** Bearer header takes precedence; `?token=` query param stays as a fallback for existing JWT clients. */
function extractToken(req: IncomingMessage, url: URL): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length);
  }
  return url.searchParams.get("token");
}

/** Opaque `hst_...` tokens are validated against the Ávimus API instead of decoded locally. */
async function verifyOpaqueToken(token: string, avimusClient: AvimusClient): Promise<GatewayTokenPayload> {
  const result = await avimusClient.validateToken(token).catch(() => {
    throw new TokenValidationError(401, "opaque token validation failed");
  });
  if (!result.valid) {
    throw new TokenValidationError(401, "invalid opaque token");
  }
  return { tenantId: result.tenantId, erpName: result.erpName, label: result.erpName, jti: token, iat: 0, exp: 0 };
}

/** Builds the `verifyClient` hook for `ws.WebSocketServer`: rejects before upgrade on any auth failure. */
export function createVerifyClient(deps: HandshakeDeps) {
  return async (info: VerifyClientInfo, callback: VerifyClientCallback): Promise<void> => {
    const req = info.req as AuthenticatedRequest;

    if (deps.isProduction && !isSecureRequest(req, info.secure)) {
      callback(false, 400, "wss required in production");
      return;
    }

    const url = new URL(req.url ?? "", "http://localhost");
    const token = extractToken(req, url);
    if (!token) {
      callback(false, 401, "missing token");
      return;
    }

    const version = url.searchParams.get("version") ?? "1.0.0";
    if (!isCompatibleProtocolVersion(version)) {
      callback(false, 403, `incompatible protocol version: ${version}`);
      return;
    }

    let payload: GatewayTokenPayload;
    try {
      payload = token.startsWith(OPAQUE_TOKEN_PREFIX)
        ? await verifyOpaqueToken(token, deps.avimusClient)
        : verifyToken(token, deps.jwtSecret);
    } catch (err) {
      const code = err instanceof TokenValidationError ? err.code : 401;
      callback(false, code, (err as Error).message);
      return;
    }

    if (deps.revocationList.isRevoked(payload.jti)) {
      callback(false, 403, "token revoked");
      return;
    }

    if (deps.registry.countForTenant(payload.tenantId) >= MAX_CONNECTIONS_PER_TENANT) {
      callback(false, 429, "tenant connection limit reached");
      return;
    }

    req.gatewayAuth = payload;
    callback(true);
  };
}
