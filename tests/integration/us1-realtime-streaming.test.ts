import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { startStubAvimusApi } from "../helpers/stubAvimusApi";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";

test("US1 golden path: connect, stream heartbeat + event, get acked", async () => {
  const avimus = await startStubAvimusApi();
  const running = await startTestApp(
    buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_API_URL: avimus.baseUrl }),
  );

  try {
    const token = makeToken(SECRET, { tenantId: "hosp-golden" });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);

    // 1. Connect with a valid token -> gateway confirms auth before anything else.
    await waitForOpenOrClose(ws);
    const authOk = await collector.next();
    assert.equal(authOk.type, "auth_ok");
    assert.equal(authOk.tenantId, "hosp-golden");

    // 2. Heartbeat is forwarded and acked.
    const heartbeatTs = new Date().toISOString();
    ws.send(JSON.stringify({ type: "heartbeat", version: "1.0.0", timestamp: heartbeatTs }));
    const heartbeatAck = await collector.next();
    assert.equal(heartbeatAck.type, "ack");
    assert.equal(avimus.heartbeats.length, 1);
    assert.equal(avimus.heartbeats[0]?.tenantId, "hosp-golden");
    assert.equal(avimus.heartbeats[0]?.timestamp, heartbeatTs);

    // 3. Clinical event is forwarded and acked.
    ws.send(
      JSON.stringify({
        type: "event",
        erpName: "tasy",
        eventCode: "PATIENT_ADMITTED",
        cpf: "12345678900",
        eventDate: new Date().toISOString(),
        metadata: { bed: "302B", unit: "UTI" },
      }),
    );
    const eventAck = await collector.next();
    assert.equal(eventAck.type, "ack");
    assert.equal(avimus.events.length, 1);
    assert.equal(avimus.events[0]?.eventCode, "PATIENT_ADMITTED");

    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("US1: expired, invalid, and revoked tokens are all rejected before any message exchange", async () => {
  const avimus = await startStubAvimusApi();
  const running = await startTestApp(
    buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_API_URL: avimus.baseUrl }),
  );

  try {
    const revokedJti = "jti-golden-revoked";
    running.app.revocationList.revoke(revokedJti);

    const cases: Array<{ label: string; token: string; expectedCode: number }> = [
      { label: "expired", token: makeToken(SECRET, {}, { expiresIn: -1 }), expectedCode: 401 },
      { label: "invalid signature", token: makeToken("wrong-secret"), expectedCode: 401 },
      { label: "revoked", token: makeToken(SECRET, { jti: revokedJti }), expectedCode: 403 },
    ];

    for (const { token, expectedCode } of cases) {
      const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
      const status = await new Promise<number>((resolve, reject) => {
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("open", () => reject(new Error("expected rejection, but connection opened")));
      });
      assert.equal(status, expectedCode);
    }

    assert.equal(avimus.heartbeats.length, 0);
    assert.equal(avimus.events.length, 0);
  } finally {
    await running.close();
    await avimus.close();
  }
});
