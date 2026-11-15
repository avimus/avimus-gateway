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
