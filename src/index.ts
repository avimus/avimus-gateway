import { loadConfig } from "./config/env";
import { createApp } from "./app";
import { gracefulShutdown } from "./shutdown";

const config = loadConfig();
const app = createApp(config);
const { server, logger } = app;

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown initiated");
  gracefulShutdown(app).then(() => {
    logger.info("shutdown complete");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(config.port, () => {
  logger.info({ port: config.port }, "avimus-gateway listening");
});
