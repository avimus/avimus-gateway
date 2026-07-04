import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, waitForClose, MessageCollector } from "../helpers/wsClient";
import { gracefulShutdown } from "../../src/shutdown";

const SECRET = "test-secret";

test("graceful shutdown closes all active connections in an orderly fashion", async () => {
  const running = await startTestApp(buildTestConfig({ GATEWAY_JWT_SECRET: SECRET }));

  const clients: WebSocket[] = [];
  for (let i = 0; i < 3; i++) {
    const token = makeToken(SECRET, { tenantId: `hosp-${i}` });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // auth_ok
    clients.push(ws);
  }

  assert.equal(running.app.registry.totalConnections(), 3);

  const closeWaiters = clients.map((ws) => waitForClose(ws));
  await gracefulShutdown(running.app, 2000);

  const results = await Promise.all(closeWaiters);
  assert.equal(results.length, 3);
  assert.equal(running.app.registry.totalConnections(), 0);
});

test("graceful shutdown resolves promptly even with zero active connections", async () => {
  const running = await startTestApp(buildTestConfig({ GATEWAY_JWT_SECRET: SECRET }));
  const start = Date.now();
  await gracefulShutdown(running.app, 2000);
  assert.ok(Date.now() - start < 2000, "should not need to wait for the timeout when nothing is connected");
});
