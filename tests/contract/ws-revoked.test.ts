import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, waitForClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";
const INTERNAL_SECRET = "top-secret";

test("revoking the active jti pushes `revoked` then closes the connection", async () => {
  const running = await startTestApp(
    buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET }),
  );
  try {
    const jti = "jti-active";
    const token = makeToken(SECRET, { jti });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // auth_ok

    const res = await fetch(`${running.baseUrl}/admin/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": INTERNAL_SECRET },
      body: JSON.stringify({ jti }),
    });
    assert.equal(res.status, 200);

    const revokedMsg = await collector.next();
    assert.equal(revokedMsg.type, "revoked");

    const closed = await waitForClose(ws);
    assert.ok(closed);
  } finally {
    await running.close();
  }
});
