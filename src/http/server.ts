import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectionRegistry } from "../ws/connectionRegistry";
import type { MessageQueue } from "../queue/messageQueue";
import type { Logger } from "../logging/logger";
import type { RevocationList } from "../auth/revocationList";
import { handleHealth } from "./health";
import { handleMetrics } from "./metrics";
import { handleRevoke } from "./revoke";
import { handleRpcQuery } from "./rpcQuery";
import type { RpcBroker } from "../rpc/rpcBroker";

export interface HttpRouterDeps {
  registry: ConnectionRegistry;
  queue: MessageQueue;
  revocationList: RevocationList;
  internalSecret: string;
  logger: Logger;
  broker: RpcBroker;
  rpcSecret: string;
}

export function createRequestHandler(deps: HttpRouterDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      handleHealth(req, res, deps.registry);
      return;
    }

    if (req.method === "GET" && path === "/metrics") {
      handleMetrics(req, res, {
        registry: deps.registry,
        queue: deps.queue,
        internalSecret: deps.internalSecret,
        logger: deps.logger,
      });
      return;
    }

    if (req.method === "POST" && path === "/admin/revoke") {
      void handleRevoke(req, res, {
        revocationList: deps.revocationList,
        registry: deps.registry,
        internalSecret: deps.internalSecret,
        logger: deps.logger,
      });
      return;
    }

    if (req.method === "POST" && path === "/internal/rpc/query") {
      handleRpcQuery(req, res, { broker: deps.broker, rpcSecret: deps.rpcSecret }).catch((err: unknown) => {
        deps.logger.error({ err: (err as Error).name }, "rpc query handler failed");
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
      return;
    }

    res.statusCode = 404;
    res.end();
  };
}
