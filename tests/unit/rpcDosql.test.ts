import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { parseRpcRequest } from "../../src/http/rpcQuery";
import { RpcBroker } from "../../src/rpc/rpcBroker";
import { parseInboundMessage } from "../../src/ws/messageSchema";
import type { ConnectionRegistry, HospitalConnection } from "../../src/ws/connectionRegistry";
import type { Logger } from "../../src/logging/logger";

// dosql (spec 027): `sql` only with consulta "dosql"; colunas/mensagem/403/409 across the tunnel; never in logs.
const base = { tenantId: "hosp-1", connectorLabel: "c1", sistema: "tasy_conector", timeoutMs: 40000 };
const SQL = "SELECT cpf FROM paciente WHERE cpf = '12345678901'";

test("parseRpcRequest: sql only with consulta dosql, then params must be empty", () => {
  assert.equal(parseRpcRequest({ ...base, consulta: "dosql", params: {}, sql: SQL })?.sql, SQL);
  for (const bad of [
    { ...base, consulta: "eventos", params: {}, sql: SQL },
    { ...base, consulta: "dosql", params: {} },
    { ...base, consulta: "dosql", params: { a: "1" }, sql: SQL },
    { ...base, consulta: "dosql", params: {}, sql: "" },
    { ...base, consulta: "dosql", params: {}, sql: "x".repeat(8001) },
    { ...base, consulta: "dosql", params: {}, sql: 1 },
  ]) assert.equal(parseRpcRequest(bad), null);
  assert.equal(parseRpcRequest({ ...base, consulta: "eventos", params: {} })?.sql, undefined);
});

test("parseInboundMessage: colunas, mensagem and 403/409 are accepted and bounded", () => {
  const requestId = "0b6f4c2e-9d1a-4c3b-8e2f-1a2b3c4d5e6f";
  const ok = parseInboundMessage(JSON.stringify({ type: "query.response", requestId, page: 0, last: true, truncado: false, duracaoMs: 1, dados: [], colunas: ["a"] }));
  assert.deepEqual(ok.type === "query.response" && ok.colunas, ["a"]);
  for (const status of [403, 409]) {
    const e = parseInboundMessage(JSON.stringify({ type: "query.error", requestId, code: "dosql_ocupado", status, mensagem: "x" }));
    assert.equal(e.type === "query.error" && e.mensagem, "x");
  }
  assert.throws(() => parseInboundMessage(JSON.stringify({ type: "query.error", requestId, code: "x", status: 502, mensagem: "x".repeat(301) })));
  assert.throws(() => parseInboundMessage(JSON.stringify({ type: "query.response", requestId, page: 0, last: true, truncado: false, duracaoMs: 1, dados: [], colunas: [1] })));
});

function broker() {
  const sent: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const connection = {
    tenantId: "hosp-1", label: "c1", lastActivityAt: new Date(),
    socket: { readyState: WebSocket.OPEN, send: (s: string) => sent.push(JSON.parse(s)) },
  } as unknown as HospitalConnection;
  const registry = { connectionsForTenant: () => [connection] } as unknown as ConnectionRegistry;
  const logger = { info: (o: unknown) => logs.push(JSON.stringify(o)), debug: () => undefined } as unknown as Logger;
  return { b: new RpcBroker(registry, logger), sent, logs, connection };
}

test("broker: forwards sql, returns colunas and mensagem, logs neither", async () => {
  const { b, sent, logs, connection } = broker();
  const pedido = parseRpcRequest({ ...base, consulta: "dosql", params: {}, sql: SQL })!;

  const ok = b.query(pedido);
  const req1 = sent[0] as { requestId: string; sql: string };
  assert.equal(req1.sql, SQL);
  b.onFrame(connection, { type: "query.response", requestId: req1.requestId, page: 0, last: true, truncado: false, duracaoMs: 5, dados: [{ a: 1 }], colunas: ["a"] });
  assert.deepEqual((await ok).body, { sistema: "tasy_conector", consulta: "dosql", quantidade: 1, truncado: false, duracao_ms: 5, dados: [{ a: 1 }], colunas: ["a"] });

  const erro = b.query(pedido);
  const req2 = sent[1] as { requestId: string };
  b.onFrame(connection, { type: "query.error", requestId: req2.requestId, code: "tasy_conector_db_erro_ora_00942", status: 502, mensagem: "ORA-00942 12345678901" });
  assert.deepEqual(await erro, { status: 502, body: { detail: "tasy_conector_db_erro_ora_00942", mensagem: "ORA-00942 12345678901" } });

  assert.ok(logs.some((l) => l.includes('"consulta":"dosql"')));
  assert.ok(logs.every((l) => !l.includes("12345678901") && !l.includes("SELECT")));
});
