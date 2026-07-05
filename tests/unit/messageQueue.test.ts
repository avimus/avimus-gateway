import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageQueue, type QueuedMessage } from "../../src/queue/messageQueue";

function heartbeat(id: string): QueuedMessage {
  return {
    messageId: id,
    kind: "heartbeat",
    payload: { tenantId: "hosp-1", version: "1.0.0", timestamp: new Date().toISOString() },
    tenantToken: "hst_test",
    queuedAt: new Date(),
  };
}

test("drains messages in FIFO order", () => {
  const queue = new MessageQueue(100);
  queue.enqueue("hosp-1", heartbeat("m1"));
  queue.enqueue("hosp-1", heartbeat("m2"));
  queue.enqueue("hosp-1", heartbeat("m3"));
  const drained = queue.drain("hosp-1");
  assert.deepEqual(
    drained.map((m) => m.messageId),
    ["m1", "m2", "m3"],
  );
});

test("drops the oldest message when capacity is exceeded", () => {
  const queue = new MessageQueue(3);
  queue.enqueue("hosp-1", heartbeat("m1"));
  queue.enqueue("hosp-1", heartbeat("m2"));
  queue.enqueue("hosp-1", heartbeat("m3"));
  queue.enqueue("hosp-1", heartbeat("m4")); // over capacity -> drops m1
  assert.equal(queue.sizeForTenant("hosp-1"), 3);
  const drained = queue.drain("hosp-1");
  assert.deepEqual(
    drained.map((m) => m.messageId),
    ["m2", "m3", "m4"],
  );
});

test("tenants have independent queues", () => {
  const queue = new MessageQueue(2);
  queue.enqueue("hosp-1", heartbeat("a1"));
  queue.enqueue("hosp-2", heartbeat("b1"));
  assert.equal(queue.sizeForTenant("hosp-1"), 1);
  assert.equal(queue.sizeForTenant("hosp-2"), 1);
});

test("drain empties the queue and hasQueued reflects it", () => {
  const queue = new MessageQueue(10);
  queue.enqueue("hosp-1", heartbeat("m1"));
  assert.equal(queue.hasQueued("hosp-1"), true);
  queue.drain("hosp-1");
  assert.equal(queue.hasQueued("hosp-1"), false);
});

test("restore puts an undelivered batch back ahead of anything arrived since, honoring capacity", () => {
  const queue = new MessageQueue(3);
  queue.enqueue("hosp-1", heartbeat("new-1")); // arrived during a hypothetical replay
  queue.restore("hosp-1", [heartbeat("old-1"), heartbeat("old-2")]);
  const drained = queue.drain("hosp-1");
  assert.deepEqual(
    drained.map((m) => m.messageId),
    ["old-1", "old-2", "new-1"],
  );
});

test("restore trims from the front when the combined batch exceeds capacity", () => {
  const queue = new MessageQueue(2);
  queue.enqueue("hosp-1", heartbeat("new-1"));
  queue.restore("hosp-1", [heartbeat("old-1"), heartbeat("old-2")]);
  const drained = queue.drain("hosp-1");
  assert.deepEqual(
    drained.map((m) => m.messageId),
    ["old-2", "new-1"],
  );
});
