import http from "node:http";
import type { AddressInfo } from "node:net";

export interface ValidateTokenRequest {
  authorization: string | undefined;
  internalSecret: string | undefined;
}

export interface StubAvimusApi {
  baseUrl: string;
  heartbeats: Record<string, unknown>[];
  events: Record<string, unknown>[];
  validateTokenRequests: ValidateTokenRequest[];
  failing: boolean;
  /** Response body returned by GET /api/v1/internal/validate-token; defaults to a valid tasy tenant. */
  validateTokenResponse: { valid: boolean; tenantId: string; erpName: string };
  close(): Promise<void>;
}

/** A local stand-in for the Avimus Patient Journey API, for contract/integration tests. */
export async function startStubAvimusApi(): Promise<StubAvimusApi> {
  const heartbeats: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const validateTokenRequests: ValidateTokenRequest[] = [];
  const state = {
    failing: false,
    validateTokenResponse: { valid: true, tenantId: "hosp-opaque", erpName: "tasy" },
  };

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/internal/validate-token") {
      validateTokenRequests.push({
        authorization: req.headers.authorization,
        internalSecret: req.headers["x-internal-secret"] as string | undefined,
      });
      if (state.failing) {
        res.statusCode = 503;
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state.validateTokenResponse));
      return;
    }

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
    validateTokenRequests,
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
    get validateTokenResponse() {
      return state.validateTokenResponse;
    },
    set validateTokenResponse(value: { valid: boolean; tenantId: string; erpName: string }) {
      state.validateTokenResponse = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
