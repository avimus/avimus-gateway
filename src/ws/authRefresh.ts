import type { InboundMessage } from "./messageSchema";
import { sendMessage, GATEWAY_VERSION } from "./protocol";
import type { HospitalConnection } from "./connectionRegistry";
import { verifyToken, TokenValidationError } from "../auth/verifyToken";
import type { RevocationList } from "../auth/revocationList";

export interface AuthRefreshDeps {
  jwtSecret: string;
  revocationList: RevocationList;
}

/** Re-validates a fresh token on an already-open connection, without requiring a reconnect. */
export function handleAuthRefresh(
  connection: HospitalConnection,
  message: Extract<InboundMessage, { type: "auth_refresh" }>,
  deps: AuthRefreshDeps,
): void {
  try {
    const payload = verifyToken(message.token, deps.jwtSecret);
    if (deps.revocationList.isRevoked(payload.jti)) {
      throw new TokenValidationError(403, "token revoked");
    }
    // A refresh renews the credential for the same session; it cannot move the
    // connection to a different tenant (the registry keys connections by the
    // tenantId established at handshake).
    if (payload.tenantId !== connection.tenantId) {
      throw new TokenValidationError(403, "refreshed token belongs to a different tenant");
    }
    connection.jti = payload.jti;
    connection.erpName = payload.erpName;
    connection.label = payload.label;
    sendMessage(connection.socket, {
      type: "auth_ok",
      tenantId: payload.tenantId,
      gatewayVersion: GATEWAY_VERSION,
    });
  } catch (err) {
    const code = err instanceof TokenValidationError ? err.code : 401;
    sendMessage(connection.socket, {
      type: "auth_error",
      reason: (err as Error).message,
      code,
    });
    connection.socket.close();
  }
}
