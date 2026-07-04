import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorized } from "./internalAuth";
import { auditLog } from "../logging/auditLog";
import { readJsonBody } from "./readJsonBody";
import { broadcastRevocation } from "../ws/revokeBroadcast";
import type { RevocationList } from "../auth/revocationList";
import type { ConnectionRegistry } from "../ws/connectionRegistry";
import type { Logger } from "../logging/logger";

export interface RevokeDeps {
  revocationList: RevocationList;
  registry: ConnectionRegistry;
  internalSecret: string;
  logger: Logger;
}

export async function handleRevoke(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RevokeDeps,
): Promise<void> {
  if (!isAuthorized(req, deps.internalSecret)) {
    auditLog(deps.logger, "revoke_denied", {});
    res.statusCode = 401;
    res.end();
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }

  const jti = typeof body === "object" && body !== null ? (body as Record<string, unknown>).jti : undefined;
  if (typeof jti !== "string" || jti.length === 0) {
    res.statusCode = 400;
    res.end();
    return;
  }

  deps.revocationList.revoke(jti);
  const affectedConnections = broadcastRevocation(jti, deps.registry);
  auditLog(deps.logger, "revoke", { jti, affectedConnections });

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ revoked: true, jti }));
}
