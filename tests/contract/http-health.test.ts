import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestConfig, startTestApp } from "../helpers/testApp";

test("GET /health requires no auth and reports status/connections/uptime", async () => {
  const running = await startTestApp(buildTestConfig());
  try {
    const res = await fetch(`${running.baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; connections: number; uptime: number };
    assert.equal(body.status, "ok");
    assert.equal(body.connections, 0);
    assert.equal(typeof body.uptime, "number");
  } finally {
    await running.close();
  }
});
