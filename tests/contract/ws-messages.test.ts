import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { startStubAvimusApi } from "../helpers/stubAvimusApi";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";

async function setup() {
  const avimus = await startStubAvimusApi();
  const running = await startTestApp(
    buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_API_URL: avimus.baseUrl }),
  );
  return { avimus, running };
}

async function connectAndAuth(wsUrl: string, token: string) {
  const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  const collector = new MessageCollector(ws);
  await waitForOpenOrClose(ws);
  await collector.next(); // auth_ok
  return { ws, collector };
}

test("heartbeat message is forwarded and acked", async () => {
  const { avimus, running } = await setup();
  try {
    const token = makeToken(SECRET);
    const { ws, collector } = await connectAndAuth(running.wsUrl, token);
    ws.send(JSON.stringify({ type: "heartbeat", version: "1.0.0", timestamp: new Date().toISOString() }));
    const ack = await collector.next();
    assert.equal(ack.type, "ack");
    assert.equal(ack.status, "received");
    assert.equal(avimus.heartbeats.length, 1);
    assert.equal(avimus.heartbeats[0]?.tenantId, "hosp-1");
    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("event message is forwarded (unmasked) and acked", async () => {
  const { avimus, running } = await setup();
  try {
    const token = makeToken(SECRET);
    const { ws, collector } = await connectAndAuth(running.wsUrl, token);
    ws.send(
      JSON.stringify({
        type: "event",
        erpName: "tasy",
        eventCode: "PATIENT_ADMITTED",
        cpf: "12345678900",
        eventDate: new Date().toISOString(),
        metadata: { bed: "302B" },
      }),
    );
    const ack = await collector.next();
    assert.equal(ack.type, "ack");
    assert.equal(avimus.events.length, 1);
    assert.equal(avimus.events[0]?.cpf, "12345678900");
    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("malformed frame yields a non-retryable error and keeps the connection open", async () => {
  const { avimus, running } = await setup();
  try {
    const token = makeToken(SECRET);
    const { ws, collector } = await connectAndAuth(running.wsUrl, token);
    ws.send("not json");
    const error = await collector.next();
    assert.equal(error.type, "error");
    assert.equal(error.retryable, false);
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("unrecognized message type yields a non-retryable error", async () => {
  const { avimus, running } = await setup();
  try {
    const token = makeToken(SECRET);
    const { ws, collector } = await connectAndAuth(running.wsUrl, token);
    ws.send(JSON.stringify({ type: "unknown_type" }));
    const error = await collector.next();
    assert.equal(error.type, "error");
    assert.equal(error.retryable, false);
    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});
