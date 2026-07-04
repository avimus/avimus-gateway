import type { App } from "./app";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Closes every active hospital connection in an orderly fashion, then the
 * HTTP server, per constitution Principle VI. Resolves once fully drained or
 * after `timeoutMs`, whichever comes first — a client that never
 * acknowledges its close frame must not block a deploy indefinitely.
 */
export function gracefulShutdown(app: App, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    for (const connection of app.registry.allConnections()) {
      connection.socket.close(1001, "server shutting down");
    }

    const timer = setTimeout(resolve, timeoutMs);

    app.server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
