import type { AddressInfo } from "node:net";
import { loadConfig, type GatewayConfig } from "../../src/config/env";
import { createApp, type App } from "../../src/app";

export function buildTestConfig(overrides: Partial<Record<string, string>> = {}): GatewayConfig {
  return loadConfig({
    GATEWAY_JWT_SECRET: "test-secret",
    AVIMUS_API_URL: "http://localhost:1", // expected to be overridden per test
    AVIMUS_INTERNAL_SECRET: "test-internal-secret",
    PORT: "0",
    LOG_LEVEL: "silent",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

export interface RunningTestApp {
  app: App;
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function startTestApp(config: GatewayConfig): Promise<RunningTestApp> {
  const app = createApp(config);
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}/ws`,
    close: () =>
      new Promise<void>((resolve) => {
        // Force-close any still-open WS connections so a test that fails
        // before calling ws.close() doesn't hang server.close() forever.
        app.server.closeAllConnections();
        app.server.close(() => resolve());
      }),
  };
}
