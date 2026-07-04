import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, waitForClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";
const INTERNAL_SECRET = "top-secret";

test("US4 golden path: revoke an active connection, then reconnecting with the same token is rejected", async () => {
  const running = await startTestApp(
    buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET }),
  );

  try {
    const jti = "jti-golden-revoke";
    const token = makeToken(SECRET, { jti });

    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // auth_ok
    assert.equal(running.app.registry.totalConnections(), 1);

    const revokeRes = await fetch(`${running.baseUrl}/admin/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ jti }),
    });
    assert.equal(revokeRes.status, 200);

    const revokedMsg = await collector.next();
    assert.equal(revokedMsg.type, "revoked");
    await waitForClose(ws);
    assert.equal(running.app.registry.totalConnections(), 0);

    // Reconnecting with the same (now-revoked) token must be rejected.
    const secondAttempt = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const status = await new Promise<number>((resolve, reject) => {
      secondAttempt.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      secondAttempt.once("open", () => reject(new Error("expected rejection, but connection opened")));
    });
    assert.equal(status, 403);
  } finally {
    await running.close();
  }
});

test("US4: revoking a jti with no active connection still blocks a future connection attempt", async () => {
  const running = await startTestApp(
    buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET }),
  );

  try {
    const jti = "jti-preemptive-revoke";
    const token = makeToken(SECRET, { jti });

    const revokeRes = await fetch(`${running.baseUrl}/admin/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ jti }),
    });
    assert.equal(revokeRes.status, 200);

    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const status = await new Promise<number>((resolve, reject) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => reject(new Error("expected rejection, but connection opened")));
    });
    assert.equal(status, 403);
  } finally {
    await running.close();
  }
});
