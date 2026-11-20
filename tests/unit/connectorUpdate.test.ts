import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleConnectorUpdate } from "../../src/http/connectorUpdate";
import type { AvimusClient } from "../../src/avimus-client/client";
import type { Logger } from "../../src/logging/logger";

const logger = { warn() {}, info() {}, error() {} } as unknown as Logger;

function fakeRes() {
  const r = { statusCode: 0, body: "", headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { r.headers[k] = v; }, end(b?: string) { r.body = b ?? ""; } };
  return r;
}
const req = (auth?: string, url = "/conector/atualizacao") =>
  ({ headers: auth ? { authorization: auth } : {}, url }) as unknown as IncomingMessage;

test("sem hst_ válido: 401 e não chama a Ávimus", async () => {
  let called = false;
  const client = { getConnectorUpdate: async () => { called = true; return {}; } } as unknown as AvimusClient;
  for (const auth of [undefined, "Bearer avk_xxxxxxxxxxxxxxxx", "Basic hst_aaaaaaaaaaaa"]) {
    const res = fakeRes();
    await handleConnectorUpdate(req(auth), res as unknown as ServerResponse, { avimusClient: client, logger });
    assert.equal(res.statusCode, 401);
  }
  assert.equal(called, false);
});

test("repassa o hst_ e o pedido de credencial; devolve o corpo da Ávimus", async () => {
  const seen: unknown[] = [];
  const client = { getConnectorUpdate: async (t: string, c: boolean) => { seen.push([t, c]); return { desiredVersion: "v1.2.0" }; } } as unknown as AvimusClient;
  const res = fakeRes();
  await handleConnectorUpdate(req("Bearer hst_abcdefghijkl", "/conector/atualizacao?credencial=1"), res as unknown as ServerResponse, { avimusClient: client, logger });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen, [["hst_abcdefghijkl", true]]);
  assert.equal(JSON.parse(res.body).desiredVersion, "v1.2.0");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

import { Readable } from "node:stream";
import { handleConnectorEvent } from "../../src/http/connectorUpdate";

const post = (auth: string, body: string) => {
  const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  (r as unknown as { headers: object }).headers = { authorization: auth, "content-length": String(body.length) };
  return r;
};

test("evento: só formato fixo passa; repassa à Ávimus", async () => {
  const seen: unknown[] = [];
  const client = { sendConnectorEvent: async (t: string, m: unknown) => { seen.push([t, m]); } } as unknown as AvimusClient;
  const ok = fakeRes();
  await handleConnectorEvent(post("Bearer hst_abcdefghijkl", JSON.stringify({ resultado: "falhou", versao: "v1.2.1", motivo: "assinatura inválida ou ausente" })), ok as unknown as ServerResponse, { avimusClient: client, logger });
  assert.equal(ok.statusCode, 202);
  for (const bad of [{ resultado: "x", versao: "v1.2.1" }, { resultado: "ok", versao: "1.2" }, { resultado: "ok", versao: "v1.2.1", motivo: "<script>" }]) {
    const res = fakeRes();
    await handleConnectorEvent(post("Bearer hst_abcdefghijkl", JSON.stringify(bad)), res as unknown as ServerResponse, { avimusClient: client, logger });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(seen.length, 1);
});

import { AxiosError, AxiosHeaders } from "axios";
import { handleConnectorPackage } from "../../src/http/connectorUpdate";

test("evento: aceita versão de pacote pacote-<sistema>-v<N>", async () => {
  const seen: unknown[] = [];
  const client = { sendConnectorEvent: async (_t: string, m: unknown) => { seen.push(m); } } as unknown as AvimusClient;
  for (const [versao, status] of [["pacote-tasy-v3", 202], ["pacote-tasy-removido", 202], ["pacote-Tasy-v3", 400], ["pacote-tasy-3", 400], ["pacote-tasy-apagado", 400]] as const) {
    const res = fakeRes();
    await handleConnectorEvent(post("Bearer hst_abcdefghijkl", JSON.stringify({ resultado: "ok", versao })), res as unknown as ServerResponse, { avimusClient: client, logger });
    assert.equal(res.statusCode, status, versao);
  }
  assert.equal(seen.length, 2);
});

test("pacote: hst_ e sistema válidos; repassa; 404 vira PACOTE_NAO_FIXADO", async () => {
  const seen: unknown[] = [];
  let notFound = false;
  const client = {
    getConnectorPackage: async (t: string, s: string) => {
      seen.push([t, s]);
      if (notFound) {
        const r = { status: 404, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data: {} };
        throw new AxiosError("nf", "ERR_BAD_REQUEST", r.config, null, r);
      }
      return { yaml: "y", bundle: "b" };
    },
  } as unknown as AvimusClient;
  const deps = { avimusClient: client, logger };

  const unauth = fakeRes();
  await handleConnectorPackage(req(undefined, "/conector/pacote?sistema=tasy"), unauth as unknown as ServerResponse, deps);
  assert.equal(unauth.statusCode, 401);
  const bad = fakeRes();
  await handleConnectorPackage(req("Bearer hst_abcdefghijkl", "/conector/pacote?sistema=../x"), bad as unknown as ServerResponse, deps);
  assert.equal(bad.statusCode, 400);
  assert.equal(seen.length, 0);

  const ok = fakeRes();
  await handleConnectorPackage(req("Bearer hst_abcdefghijkl", "/conector/pacote?sistema=tasy"), ok as unknown as ServerResponse, deps);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { yaml: "y", bundle: "b" });
  assert.deepEqual(seen, [["hst_abcdefghijkl", "tasy"]]);

  notFound = true;
  const nf = fakeRes();
  await handleConnectorPackage(req("Bearer hst_abcdefghijkl", "/conector/pacote?sistema=tasy"), nf as unknown as ServerResponse, deps);
  assert.equal(nf.statusCode, 404);
  assert.equal(JSON.parse(nf.body).code, "PACOTE_NAO_FIXADO");
});
