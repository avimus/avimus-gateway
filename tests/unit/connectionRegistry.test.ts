import { test } from "node:test";
import assert from "node:assert/strict";
import type WebSocket from "ws";
import {
  ConnectionRegistry,
  ConnectionLimitExceededError,
  MAX_CONNECTIONS_PER_TENANT,
  type HospitalConnection,
} from "../../src/ws/connectionRegistry";

function fakeConnection(tenantId: string, jti: string): HospitalConnection {
  return {
    tenantId,
    erpName: "tasy",
    label: "unit-test",
    jti,
    socket: {} as WebSocket,
    protocolVersion: "1.0.0",
    connectedAt: new Date(),
    lastActivityAt: new Date(),
  };
}

test("accepts up to the per-tenant connection limit", () => {
  const registry = new ConnectionRegistry();
  for (let i = 0; i < MAX_CONNECTIONS_PER_TENANT; i++) {
    registry.add(fakeConnection("hosp-1", `jti-${i}`));
  }
  assert.equal(registry.countForTenant("hosp-1"), MAX_CONNECTIONS_PER_TENANT);
});

test("rejects the connection beyond the per-tenant limit without affecting existing ones", () => {
  const registry = new ConnectionRegistry();
  for (let i = 0; i < MAX_CONNECTIONS_PER_TENANT; i++) {
    registry.add(fakeConnection("hosp-1", `jti-${i}`));
  }
  assert.throws(
    () => registry.add(fakeConnection("hosp-1", "jti-overflow")),
    ConnectionLimitExceededError,
  );
  assert.equal(registry.countForTenant("hosp-1"), MAX_CONNECTIONS_PER_TENANT);
});

test("different tenants have independent limits", () => {
  const registry = new ConnectionRegistry();
  for (let i = 0; i < MAX_CONNECTIONS_PER_TENANT; i++) {
    registry.add(fakeConnection("hosp-1", `jti-${i}`));
  }
  registry.add(fakeConnection("hosp-2", "jti-other"));
  assert.equal(registry.countForTenant("hosp-2"), 1);
  assert.equal(registry.totalConnections(), MAX_CONNECTIONS_PER_TENANT + 1);
});

test("remove() frees a slot for that tenant", () => {
  const registry = new ConnectionRegistry();
  const first = fakeConnection("hosp-1", "jti-0");
  registry.add(first);
  registry.remove(first);
  assert.equal(registry.countForTenant("hosp-1"), 0);
  assert.doesNotThrow(() => registry.add(fakeConnection("hosp-1", "jti-1")));
});

test("findByJti locates a connection across tenants", () => {
  const registry = new ConnectionRegistry();
  const conn = fakeConnection("hosp-1", "jti-target");
  registry.add(conn);
  registry.add(fakeConnection("hosp-2", "jti-other"));
  const found = registry.findByJti("jti-target");
  assert.equal(found.length, 1);
  assert.equal(found[0], conn);
});
