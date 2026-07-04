import type { IncomingMessage } from "node:http";
import { verifyToken, TokenValidationError, type GatewayTokenPayload } from "../auth/verifyToken";
import type { RevocationList } from "../auth/revocationList";
import { isCompatibleProtocolVersion } from "./protocolVersion";
import { MAX_CONNECTIONS_PER_TENANT, type ConnectionRegistry } from "./connectionRegistry";

export interface HandshakeDeps {
  jwtSecret: string;
  revocationList: RevocationList;
  isProduction: boolean;
  registry: ConnectionRegistry;
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

/** Builds the `verifyClient` hook for `ws.WebSocketServer`: rejects before upgrade on any auth failure. */
export function createVerifyClient(deps: HandshakeDeps) {
  return (info: VerifyClientInfo, callback: VerifyClientCallback): void => {
    const req = info.req as AuthenticatedRequest;

    if (deps.isProduction && !isSecureRequest(req, info.secure)) {
      callback(false, 400, "wss required in production");
      return;
    }

    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token");
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
      payload = verifyToken(token, deps.jwtSecret);
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
