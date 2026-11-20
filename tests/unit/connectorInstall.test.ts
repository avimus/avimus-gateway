import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleConnectorInstall } from "../../src/http/connectorInstall";

function call(host: string) {
  const r = { statusCode: 0, body: "", headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { r.headers[k] = v; }, end(b?: string) { r.body = b ?? ""; } };
  handleConnectorInstall({ headers: { host } } as unknown as IncomingMessage, r as unknown as ServerResponse);
  return r;
}

test("serve o primeiro passo com o endereço do gateway e sem segredo", () => {
  const r = call("gateway.avimus.com.br");
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /GW="https:\/\/gateway\.avimus\.com\.br"/);
  assert.match(r.body, /REF="\$IMG:\$\{VER:-latest\}"/);
  assert.doesNotMatch(r.body, /__GW__/);
  execFileSync("bash", ["-n"], { input: r.body }); // sintaxe do shell
});

test("Host estranho é recusado", () => {
  assert.equal(call("x;rm -rf /").statusCode, 400);
});

test("extrai imagem, versão e credencial da resposta da Ávimus", () => {
  const body = call("g.test").body;
  const campo = body.split("\n").find((l) => l.startsWith("campo()"))!;
  const json = JSON.stringify({ image: "ghcr.io/avimus/avimus-conector", desiredVersion: "v1.5.0", desiredDigest: null,
    registry: { host: "ghcr.io", username: "leitor", token: "ghp_abc123" }, pacotes: [], desligadas: [] });
  const out = execFileSync("bash", ["-c", `${campo}\nR='${json}'\necho "$(campo image)|$(campo desiredVersion)|$(campo username)|$(campo token)"`]).toString().trim();
  assert.equal(out, "ghcr.io/avimus/avimus-conector|v1.5.0|leitor|ghp_abc123");
});
