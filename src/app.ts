import http from "node:http";
import type { GatewayConfig } from "./config/env";
import { createLogger, type Logger } from "./logging/logger";
import { RevocationList } from "./auth/revocationList";
import { ConnectionRegistry } from "./ws/connectionRegistry";
import { AvimusClient } from "./avimus-client/client";
import { createWsServer } from "./ws/server";
import { MessageQueue } from "./queue/messageQueue";
import { createRequestHandler } from "./http/server";

export interface App {
  server: http.Server;
  logger: Logger;
  registry: ConnectionRegistry;
  revocationList: RevocationList;
  avimusClient: AvimusClient;
  queue: MessageQueue;
}

/** Composition root: wires config into the HTTP+WS server, without starting it. */
export function createApp(config: GatewayConfig): App {
  const logger = createLogger(config.logLevel);
  const revocationList = new RevocationList();
  const registry = new ConnectionRegistry();
  const avimusClient = new AvimusClient(config.avimusApiUrl, config.avimusInternalSecret);
  const queue = new MessageQueue(config.maxQueuePerTenant);

  const server = http.createServer(
    createRequestHandler({
      registry,
      queue,
      revocationList,
      internalSecret: config.avimusInternalSecret,
      logger,
    }),
  );

  // ponytail: debug aid for tracing 403s through SnapDeploy's proxy; remove once the opaque-token rollout is confirmed stable.
  server.on("upgrade", (req) => {
    logger.info({ method: req.method, url: req.url, headers: req.headers }, "http server: upgrade event received");
  });

  createWsServer(server, {
    jwtSecret: config.gatewayJwtSecret,
    revocationList,
    isProduction: config.isProduction,
    registry,
    avimusClient,
    logger,
    queue,
  });

  return { server, logger, registry, revocationList, avimusClient, queue };
}
