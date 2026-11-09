import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp, type RunningTestApp } from "../helpers/testApp";
import { startStubAvimusApi } from "../helpers/stubAvimusApi";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, MessageCollector } from "../helpers/wsClient";

// Contract: specs/002-connector-rpc/contracts/tunnel.md — POST /internal/rpc/query.
const SECRET = "test-secret";
const RPC_SECRET = "r".repeat(40);

async function setup(rpcSecret = RPC_SECRET) {
  const avimus = await startStubAvimusApi();
  const running = await startTestApp(buildTestConfig({ GATEWAY_JWT_SECRET: SECRET, AVIMUS_API_URL: avimus.baseUrl, GATEWAY_RPC_SECRET: rpcSecret }));
  return { avimus, running };
}

async function connector(running: RunningTestApp, tenantId = "hosp-1", label = "unidade-centro") {
  const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(makeToken(SECRET, { tenantId, label }))}`);
  const frames = new MessageCollector(ws);
  await waitForOpenOrClose(ws);
  await frames.next(); // auth_ok
  return { ws, frames };
}

const body = (over: Record<string, unknown> = {}) => ({
  tenantId: "hosp-1", connectorLabel: "unidade-centro", sistema: "shift", consulta: "eventos",
  params: { desde: "2026-11-09T14:00:00", limite: "1000" }, timeoutMs: 5000, ...over,
});

function ask(running: RunningTestApp, payload: unknown, secret = RPC_SECRET) {
  return fetch(`${running.baseUrl}/internal/rpc/query`, {
    method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(payload),
  });
}

async function withApp(fn: (running: RunningTestApp) => Promise<void>, rpcSecret?: string) {
  const { avimus, running } = await setup(rpcSecret);
  try {
    await fn(running);
  } finally {
    await running.close();
    await avimus.close();
  }
}

test("rpc: off without GATEWAY_RPC_SECRET; wrong secret 401; malformed body 422", async () => {
  await withApp(async (running) => {
    assert.equal((await ask(running, body())).status, 404);
  }, "");
  await withApp(async (running) => {
    assert.equal((await ask(running, body(), "x".repeat(40))).status, 401);
    for (const bad of [body({ timeoutMs: 999999 }), body({ sistema: "Shift;DROP" }), body({ params: { desde: 1 } }), body({ connectorLabel: "a b" })]) {
      const r = await ask(running, bad);
      assert.equal(r.status, 422);
      assert.deepEqual(await r.json(), { detail: "pedido_invalido" });
    }
  });
});

test("rpc: no connector for tenant + label → 503 connector_offline", async () => {
  await withApp(async (running) => {
    const { ws } = await connector(running, "hosp-1", "outro-label");
    const r = await ask(running, body());
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { detail: "connector_offline" });
    ws.close();
  });
});

test("rpc: request reaches the connector; pages are joined in the connector API format", async () => {
  await withApp(async (running) => {
    const { ws, frames } = await connector(running);
    const pending = ask(running, body());
    const req = await frames.next();
    assert.equal(req.type, "query.request");
    assert.deepEqual({ sistema: req.sistema, consulta: req.consulta, params: req.params, timeoutMs: req.timeoutMs },
      { sistema: "shift", consulta: "eventos", params: { desde: "2026-11-09T14:00:00", limite: "1000" }, timeoutMs: 5000 });
    ws.send(JSON.stringify({ type: "query.response", requestId: req.requestId, page: 0, last: false, truncado: false, duracaoMs: 0, dados: [{ source_key: 1 }] }));
    ws.send(JSON.stringify({ type: "query.response", requestId: req.requestId, page: 1, last: true, truncado: true, duracaoMs: 42, dados: [{ source_key: 2 }] }));
    const r = await pending;
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { sistema: "shift", consulta: "eventos", quantidade: 2, truncado: true, duracao_ms: 42, dados: [{ source_key: 1 }, { source_key: 2 }] });
    ws.close();
  });
});

test("rpc: query.error passes its safe code and status through", async () => {
  await withApp(async (running) => {
    const { ws, frames } = await connector(running);
    const pending = ask(running, body());
    const req = await frames.next();
    ws.send(JSON.stringify({ type: "query.error", requestId: req.requestId, code: "shift_db_timeout", status: 504 }));
    const r = await pending;
    assert.equal(r.status, 504);
    assert.deepEqual(await r.json(), { detail: "shift_db_timeout" });
    ws.close();
  });
});

test("rpc: another tenant's connector cannot answer; silence ends in 504 connector_timeout", async () => {
  await withApp(async (running) => {
    const { ws, frames } = await connector(running);
    const intruso = await connector(running, "hosp-2", "unidade-centro");
    const pending = ask(running, body({ timeoutMs: 1000 }));
    const req = await frames.next();
    intruso.ws.send(JSON.stringify({ type: "query.response", requestId: req.requestId, page: 0, last: true, truncado: false, duracaoMs: 1, dados: [{ x: 1 }] }));
    const r = await pending;
    assert.equal(r.status, 504);
    assert.deepEqual(await r.json(), { detail: "connector_timeout" });
    ws.close();
    intruso.ws.close();
  });
});

test("rpc: connector drops mid-request → 503 connector_offline at once; page out of order → 502", async () => {
  await withApp(async (running) => {
    const first = await connector(running);
    const pending = ask(running, body());
    await first.frames.next();
    first.ws.close();
    assert.deepEqual(await (await pending).json(), { detail: "connector_offline" });

    const second = await connector(running);
    const outOfOrder = ask(running, body());
    const req = await second.frames.next();
    second.ws.send(JSON.stringify({ type: "query.response", requestId: req.requestId, page: 1, last: true, truncado: false, duracaoMs: 1, dados: [] }));
    const r = await outOfOrder;
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { detail: "connector_protocol_error" });
    second.ws.close();
  });
});

test("rpc: at most 4 requests in flight per connection → 503 connector_busy", async () => {
  await withApp(async (running) => {
    const { ws, frames } = await connector(running);
    const inFlight = [0, 1, 2, 3].map(() => ask(running, body()));
    const requests = await Promise.all([0, 1, 2, 3].map(() => frames.next()));
    const fifth = await ask(running, body());
    assert.equal(fifth.status, 503);
    assert.deepEqual(await fifth.json(), { detail: "connector_busy" });
    for (const req of requests) ws.send(JSON.stringify({ type: "query.error", requestId: req.requestId, code: "shift_db_ocupado", status: 503 }));
    await Promise.all(inFlight);
    ws.close();
  });
});

test("rpc: hst_ connector (real Ávimus answer has no erpName) is addressed by its token prefix", async () => {
  const { avimus, running } = await setup();
  try {
    (avimus as unknown as { validateTokenResponse: unknown }).validateTokenResponse = { valid: true, tenantId: "tenant-avimus-1" };
    const token = "hst_ab12cd34" + "f".repeat(40);
    const ws = new WebSocket(running.wsUrl, { headers: { authorization: `Bearer ${token}` } });
    const frames = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await frames.next(); // auth_ok
    const pending = ask(running, body({ tenantId: "tenant-avimus-1", connectorLabel: "hst_ab12cd34" }));
    const req = await frames.next();
    ws.send(JSON.stringify({ type: "query.error", requestId: req.requestId, code: "shift_db_ocupado", status: 503 }));
    assert.deepEqual(await (await pending).json(), { detail: "shift_db_ocupado" });
    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("rpc: label is the token prefix even when the Ávimus returns erpName (two units never share a label)", async () => {
  const { avimus, running } = await setup();
  try {
    (avimus as unknown as { validateTokenResponse: unknown }).validateTokenResponse = { valid: true, tenantId: "tenant-avimus-1", erpName: "sgu" };
    const ws = new WebSocket(running.wsUrl, { headers: { authorization: `Bearer hst_ffff0000${"a".repeat(40)}` } });
    const frames = new MessageCollector(ws);
    await waitForOpenOrClose(ws);
    await frames.next();
    const porErp = await ask(running, body({ tenantId: "tenant-avimus-1", connectorLabel: "sgu" }));
    assert.deepEqual(await porErp.json(), { detail: "connector_offline" });
    const pending = ask(running, body({ tenantId: "tenant-avimus-1", connectorLabel: "hst_ffff0000" }));
    const req = await frames.next();
    ws.send(JSON.stringify({ type: "query.error", requestId: req.requestId, code: "sgu_db_ocupado", status: 503 }));
    assert.equal((await pending).status, 503);
    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("rpc: more rows than the cap (memory grows with rows, not bytes) → 502 resposta_grande_demais", async () => {
  await withApp(async (running) => {
    const { ws, frames } = await connector(running);
    const pending = ask(running, body());
    const req = await frames.next();
    const rows = Array.from({ length: 6000 }, () => ({}));
    ws.send(JSON.stringify({ type: "query.response", requestId: req.requestId, page: 0, last: false, truncado: false, duracaoMs: 0, dados: rows }));
    ws.send(JSON.stringify({ type: "query.response", requestId: req.requestId, page: 1, last: true, truncado: false, duracaoMs: 0, dados: rows }));
    const r = await pending;
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { detail: "shift_resposta_grande_demais" });
    ws.close();
  });
});
