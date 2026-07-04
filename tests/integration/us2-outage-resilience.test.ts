import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp } from "../helpers/testApp";
import { startStubAvimusApi } from "../helpers/stubAvimusApi";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";

// Distinguishes messages by an encoded sequence number in the timestamp
// field, since the wire schema only carries {version, timestamp} through.
function heartbeat(seq: number) {
  return { type: "heartbeat", version: "1.0.0", timestamp: `seq-${seq}` };
}

test("US2: messages sent during an outage are still acked, then delivered in order once restored", async () => {
  const avimus = await startStubAvimusApi();
  const running = await startTestApp(
    buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_API_URL: avimus.baseUrl }),
  );

  try {
    const token = makeToken(SECRET, { tenantId: "hosp-outage" });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // auth_ok

    // Avimus goes down.
    avimus.failing = true;

    ws.send(JSON.stringify(heartbeat(1)));
    const ack1 = await collector.next();
    assert.equal(ack1.type, "ack");

    ws.send(JSON.stringify(heartbeat(2)));
    const ack2 = await collector.next();
    assert.equal(ack2.type, "ack");

    // Message 2's arrival triggers a fire-and-forget flush attempt (still
    // failing at this point); let it settle back into the queue via restore()
    // before asserting on queue state.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(avimus.heartbeats.length, 0, "nothing should have reached Avimus yet");
    assert.equal(running.app.queue.sizeForTenant("hosp-outage"), 2);

    // Avimus comes back — the next message triggers a full-backlog flush.
    avimus.failing = false;
    ws.send(JSON.stringify(heartbeat(3)));
    const ack3 = await collector.next();
    assert.equal(ack3.type, "ack");

    // Give the fire-and-forget flush a tick to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(avimus.heartbeats.length, 3);
    assert.deepEqual(
      avimus.heartbeats.map((h) => h.timestamp),
      ["seq-1", "seq-2", "seq-3"],
    );
    assert.equal(running.app.queue.sizeForTenant("hosp-outage"), 0);

    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("US2: the 101st message during a sustained outage discards the oldest held one", async () => {
  const avimus = await startStubAvimusApi();
  avimus.failing = true;
  const running = await startTestApp(
    buildTestConfig({
      GATEWAY_JWT_SECRET: SECRET,
      AVIMUS_API_URL: avimus.baseUrl,
      MAX_QUEUE_PER_TENANT: "100",
    }),
  );

  try {
    const token = makeToken(SECRET, { tenantId: "hosp-overflow" });
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`);
    const collector = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await collector.next(); // auth_ok

    for (let seq = 1; seq <= 101; seq++) {
      ws.send(JSON.stringify(heartbeat(seq)));
      const ack = await collector.next();
      assert.equal(ack.type, "ack");
    }

    assert.equal(running.app.queue.sizeForTenant("hosp-overflow"), 100);
    const drained = running.app.queue.drain("hosp-overflow");
    assert.equal(
      (drained[0]?.payload as { timestamp?: string }).timestamp,
      "seq-2",
      "message 1 (oldest) should have been dropped",
    );
    assert.equal((drained[99]?.payload as { timestamp?: string }).timestamp, "seq-101");

    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});
