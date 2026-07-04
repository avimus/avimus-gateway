import type http from "node:http";
import { WebSocketServer } from "ws";
import { createVerifyClient, type AuthenticatedRequest } from "./handshake";
import { ConnectionRegistry, type HospitalConnection } from "./connectionRegistry";
import { parseInboundMessage, MessageValidationError } from "./messageSchema";
import { sendMessage, GATEWAY_VERSION } from "./protocol";
import { handleApplicationMessage } from "./messageHandler";
import { handleAuthRefresh } from "./authRefresh";
import type { RevocationList } from "../auth/revocationList";
import type { AvimusClient } from "../avimus-client/client";
import type { Logger } from "../logging/logger";
import type { MessageQueue } from "../queue/messageQueue";
import { notifyOffline } from "../avimus-client/offlineNotifier";

export interface WsServerDeps {
  jwtSecret: string;
  revocationList: RevocationList;
  isProduction: boolean;
  registry: ConnectionRegistry;
  avimusClient: AvimusClient;
  logger: Logger;
  queue: MessageQueue;
}

export function createWsServer(httpServer: http.Server, deps: WsServerDeps): WebSocketServer {
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    verifyClient: createVerifyClient({
      jwtSecret: deps.jwtSecret,
      revocationList: deps.revocationList,
      isProduction: deps.isProduction,
      registry: deps.registry,
    }),
  });

  wss.on("connection", (socket, req) => {
    const auth = (req as AuthenticatedRequest).gatewayAuth;
    if (!auth) {
      // Should be unreachable: verifyClient rejects before upgrade otherwise.
      socket.close();
      return;
    }

    const url = new URL(req.url ?? "", "http://localhost");
    const protocolVersion = url.searchParams.get("version") ?? "1.0.0";

    const connection: HospitalConnection = {
      tenantId: auth.tenantId,
      erpName: auth.erpName,
      label: auth.label,
      jti: auth.jti,
      socket,
      protocolVersion,
      connectedAt: new Date(),
      lastActivityAt: new Date(),
    };

    try {
      deps.registry.add(connection);
    } catch (err) {
      sendMessage(socket, { type: "auth_error", reason: (err as Error).message, code: 403 });
      socket.close();
      return;
    }

    sendMessage(socket, {
      type: "auth_ok",
      tenantId: connection.tenantId,
      gatewayVersion: GATEWAY_VERSION,
    });

    socket.on("message", (data) => {
      void handleRawMessage(connection, data.toString(), deps);
    });

    socket.on("close", () => {
      deps.registry.remove(connection);
      // Only report "offline" once every connection for this tenant has
      // dropped — a tenant may hold up to 10 concurrent sessions, and one
      // session closing doesn't mean the hospital itself is offline.
      if (deps.registry.countForTenant(connection.tenantId) === 0) {
        notifyOffline(connection.tenantId, { avimusClient: deps.avimusClient, logger: deps.logger }).catch(
          (err: unknown) => {
            deps.logger.error({ tenantId: connection.tenantId, err }, "unexpected error notifying offline status");
          },
        );
      }
    });
  });

  return wss;
}

async function handleRawMessage(
  connection: HospitalConnection,
  raw: string,
  deps: WsServerDeps,
): Promise<void> {
  let message;
  try {
    message = parseInboundMessage(raw);
  } catch (err) {
    const reason = err instanceof MessageValidationError ? err.message : "invalid message";
    sendMessage(connection.socket, { type: "error", messageId: null, reason, retryable: false });
    return;
  }

  if (message.type === "auth_refresh") {
    handleAuthRefresh(connection, message, {
      jwtSecret: deps.jwtSecret,
      revocationList: deps.revocationList,
    });
    return;
  }

  await handleApplicationMessage(connection, message, {
    avimusClient: deps.avimusClient,
    logger: deps.logger,
    queue: deps.queue,
  });
}
