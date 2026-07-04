import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, waitForClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";

async function setup() {
  return startTestApp(buildTestConfig({ GATEWAY_JWT_SECRET: SECRET }));
}

test("auth_refresh with a valid new token: auth_ok, connection stays open", async () => {
  const running = await setup();
  try {
    const token = makeToken(SECRET, { jti: "jti-original" });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // initial auth_ok

    const refreshedToken = makeToken(SECRET, { jti: "jti-refreshed" });
    ws.send(JSON.stringify({ type: "auth_refresh", token: refreshedToken }));
    const refreshed = await collector.next();

    assert.equal(refreshed.type, "auth_ok");
    assert.equal(refreshed.tenantId, "hosp-1");
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    await running.close();
  }
});

test("auth_refresh with an invalid token: auth_error, connection closes", async () => {
  const running = await setup();
  try {
    const token = makeToken(SECRET);
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // initial auth_ok

    ws.send(JSON.stringify({ type: "auth_refresh", token: "not-a-valid-jwt" }));
    const errorMsg = await collector.next();
    assert.equal(errorMsg.type, "auth_error");
    assert.equal(errorMsg.code, 401);

    const closed = await waitForClose(ws);
    assert.ok(closed);
  } finally {
    await running.close();
  }
});

test("auth_refresh to a different tenant is rejected", async () => {
  const running = await setup();
  try {
    const token = makeToken(SECRET, { tenantId: "hosp-1" });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // initial auth_ok

    const otherTenantToken = makeToken(SECRET, { tenantId: "hosp-2" });
    ws.send(JSON.stringify({ type: "auth_refresh", token: otherTenantToken }));
    const errorMsg = await collector.next();
    assert.equal(errorMsg.type, "auth_error");
    assert.equal(errorMsg.code, 403);
  } finally {
    await running.close();
  }
});
