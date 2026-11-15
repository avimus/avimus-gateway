import type { IncomingMessage, ServerResponse } from "node:http";
import axios from "axios";
import type { AvimusClient } from "../avimus-client/client";
import type { Logger } from "../logging/logger";

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
