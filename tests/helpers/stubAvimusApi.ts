import http from "node:http";
import type { AddressInfo } from "node:net";

export interface StubAvimusApi {
  baseUrl: string;
  heartbeats: Record<string, unknown>[];
  events: Record<string, unknown>[];
  failing: boolean;
  close(): Promise<void>;
}

/** A local stand-in for the Avimus Patient Journey API, for contract/integration tests. */
export async function startStubAvimusApi(): Promise<StubAvimusApi> {
  const heartbeats: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const state = { failing: false };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (state.failing) {
        res.statusCode = 503;
        res.end();
        return;
      }
      const parsed = body ? JSON.parse(body) : {};
      if (req.url === "/api/v1/internal/heartbeat") heartbeats.push(parsed);
      else if (req.url === "/api/v1/internal/events") events.push(parsed);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://localhost:${port}`,
    heartbeats,
    events,
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
