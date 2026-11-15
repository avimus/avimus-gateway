import type { IncomingMessage, ServerResponse } from "node:http";
import axios from "axios";
import type { AvimusClient } from "../avimus-client/client";
import type { Logger } from "../logging/logger";
import { readJsonBody } from "./readJsonBody";

// Atualizador/instalador do conector no hospital: GET /conector/atualizacao com o hst_ do próprio hospital
// (Authorization: Bearer). O gateway só repassa à Ávimus, que resolve o tenant pelo token; nada é guardado aqui.
// ponytail: sem limite por IP; o hst_ é aleatório (adivinhar não é viável) e a Ávimus já recusa token inválido.
const HST = /^hst_[A-Za-z0-9_-]{10,200}$/;

export async function handleConnectorUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { avimusClient: AvimusClient; logger: Logger },
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!token || !HST.test(token)) {
    res.statusCode = 401;
    res.end();
    return;
  }
  const withCredential = new URL(req.url ?? "/", "http://localhost").searchParams.get("credencial") === "1";
  try {
    const body = await deps.avimusClient.getConnectorUpdate(token, withCredential);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    res.statusCode = status === 401 ? 401 : 502;
    if (res.statusCode === 502) deps.logger.warn({ status }, "connector update lookup failed");
    res.end();
  }
}

// Resultado de cada tentativa do atualizador (POST /conector/evento): vira evento do tenant na Ávimus
// (tenant_health, `conector_atualizacao`) e aparece na aba Conector. Só textos fixos do script, validados aqui.
const RESULTADOS = new Set(["inicio", "ok", "falhou"]);
const VERSAO = /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MOTIVO = /^[\p{L}\p{N} ():./@_,+-]{0,200}$/u;

export async function handleConnectorEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { avimusClient: AvimusClient; logger: Logger },
): Promise<void> {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!token || !HST.test(token)) {
    res.statusCode = 401;
    res.end();
    return;
  }
  if (Number(req.headers["content-length"] ?? 0) > 2048) {
    res.statusCode = 413;
    res.end();
    return;
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    body = undefined;
  }
  const b = (body ?? {}) as { resultado?: unknown; versao?: unknown; motivo?: unknown };
  if (typeof b.resultado !== "string" || !RESULTADOS.has(b.resultado)
    || typeof b.versao !== "string" || !VERSAO.test(b.versao)
    || (b.motivo !== undefined && (typeof b.motivo !== "string" || !MOTIVO.test(b.motivo)))) {
    res.statusCode = 400;
    res.end();
    return;
  }
  try {
    await deps.avimusClient.sendConnectorEvent(token, { resultado: b.resultado, versao: b.versao, motivo: b.motivo || undefined });
    res.statusCode = 202;
    res.end();
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : undefined;
    res.statusCode = status === 401 ? 401 : 502;
    if (res.statusCode === 502) deps.logger.warn({ status }, "connector event forward failed");
    res.end();
  }
}
