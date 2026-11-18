export type InboundMessage =
  | { type: "heartbeat"; version: string; timestamp: string }
  | { type: "auth_refresh"; token: string }
  | {
      type: "query.response";
      requestId: string;
      page: number;
      last: boolean;
      truncado: boolean;
      duracaoMs: number;
      dados: Record<string, unknown>[];
      /** dosql (spec 027): column order of the SELECT, on the last page. */
      colunas?: string[];
    }
  /** `mensagem`: dosql only, database text for the admin screen; never logged (it can carry patient data). */
  | { type: "query.error"; requestId: string; code: string; status: number; mensagem?: string };

// Contract: specs/002-connector-rpc/contracts/tunnel.md
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_CODE = /^[a-z][a-z0-9_:]{0,60}$/;
// 403 (dosql off/expired) and 409 (dosql busy): spec 027.
const ERROR_STATUSES = new Set([403, 404, 409, 422, 502, 503, 504]);
const MAX_COLUNAS = 500;
const MAX_MENSAGEM = 300;
// Characters (code points), as the connector (Python) counts them: an emoji is 2 UTF-16 units in `.length`.
const chars = (s: string) => [...s].length;
const isNonNegativeInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageValidationError";
  }
}

export function parseInboundMessage(raw: string): InboundMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MessageValidationError("message is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new MessageValidationError("message must be a JSON object");
  }
  const msg = parsed as Record<string, unknown>;

  switch (msg.type) {
    case "heartbeat": {
      if (typeof msg.version !== "string" || typeof msg.timestamp !== "string") {
        throw new MessageValidationError("heartbeat requires version and timestamp");
      }
      return { type: "heartbeat", version: msg.version, timestamp: msg.timestamp };
    }
    case "event":
      // D1 (09/11/2026): the tunnel carries health only; journeys come from the integrations worker.
      // Contract: specs/002-connector-rpc/contracts/tunnel.md.
      throw new MessageValidationError("event is not accepted: health only (journeys come from the worker)");
    case "auth_refresh": {
      if (typeof msg.token !== "string") {
        throw new MessageValidationError("auth_refresh requires token");
      }
      return { type: "auth_refresh", token: msg.token };
    }
    case "query.response": {
      if (typeof msg.requestId !== "string" || !REQUEST_ID.test(msg.requestId)) {
        throw new MessageValidationError("query.response requires a UUID v4 requestId");
      }
      if (!isNonNegativeInt(msg.page) || typeof msg.last !== "boolean" || typeof msg.truncado !== "boolean" ||
          !isNonNegativeInt(msg.duracaoMs) || !Array.isArray(msg.dados) ||
          !msg.dados.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
        throw new MessageValidationError("query.response requires page, last, truncado, duracaoMs and dados rows");
      }
      const colunas = msg.colunas;
      if (colunas !== undefined && !(Array.isArray(colunas) && colunas.length <= MAX_COLUNAS &&
          colunas.every((c) => typeof c === "string" && c.length > 0 && chars(c) <= 128))) {
        throw new MessageValidationError("query.response colunas must be up to 500 short strings");
      }
      return {
        type: "query.response", requestId: msg.requestId, page: msg.page, last: msg.last,
        truncado: msg.truncado, duracaoMs: msg.duracaoMs, dados: msg.dados as Record<string, unknown>[],
        ...(colunas ? { colunas: colunas as string[] } : {}),
      };
    }
    case "query.error": {
      if (typeof msg.requestId !== "string" || !REQUEST_ID.test(msg.requestId)) {
        throw new MessageValidationError("query.error requires a UUID v4 requestId");
      }
      // Only a safe code ever crosses the tunnel: never driver text (it can carry data).
      if (typeof msg.code !== "string" || !SAFE_CODE.test(msg.code) || typeof msg.status !== "number" || !ERROR_STATUSES.has(msg.status)) {
        throw new MessageValidationError("query.error requires a safe code and a known status");
      }
      const mensagem = msg.mensagem;
      if (mensagem !== undefined && !(typeof mensagem === "string" && chars(mensagem) <= MAX_MENSAGEM)) {
        throw new MessageValidationError("query.error mensagem must be a string up to 300 characters");
      }
      return {
        type: "query.error", requestId: msg.requestId, code: msg.code, status: msg.status,
        ...(mensagem ? { mensagem } : {}),
      };
    }
    default:
      throw new MessageValidationError(`unrecognized message type: ${String(msg.type)}`);
  }
}
