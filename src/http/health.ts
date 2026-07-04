import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectionRegistry } from "../ws/connectionRegistry";

export function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  registry: ConnectionRegistry,
): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      status: "ok",
      connections: registry.totalConnections(),
      uptime: process.uptime(),
    }),
  );
}
