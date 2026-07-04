import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { startStubAvimusApi } from "../helpers/stubAvimusApi";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";
const INTERNAL_SECRET = "top-secret";

test("US3: operator can see gateway health and per-hospital connection detail", async () => {
  const avimus = await startStubAvimusApi();
  const running = await startTestApp(
    buildTestConfig({
      GATEWAY_JWT_SECRET: SECRET,
      AVIMUS_API_URL: avimus.baseUrl,
      AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET,
    }),
  );

  try {
    const token = makeToken(SECRET, { tenantId: "hosp-monitored" });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // auth_ok

    const health = await fetch(`${running.baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthBody = (await health.json()) as { connections: number };
    assert.equal(healthBody.connections, 1);

    const deniedMetrics = await fetch(`${running.baseUrl}/metrics`);
    assert.equal(deniedMetrics.status, 401);

    const metrics = await fetch(`${running.baseUrl}/metrics`, {
      headers: { "x-internal-secret": INTERNAL_SECRET },
    });
    assert.equal(metrics.status, 200);
    const metricsBody = (await metrics.json()) as {
      tenants: Array<{ tenantId: string; activeConnections: number }>;
    };
    const tenant = metricsBody.tenants.find((t) => t.tenantId === "hosp-monitored");
    assert.ok(tenant, "expected hosp-monitored in metrics");
    assert.equal(tenant.activeConnections, 1);

    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});
