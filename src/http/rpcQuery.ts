import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RpcBroker, RpcRequest } from "../rpc/rpcBroker";

// POST /internal/rpc/query — the integrations worker asks a named query of a tenant's connector.
// Contract: specs/002-connector-rpc/contracts/tunnel.md. Own secret (GATEWAY_RPC_SECRET), not the Ávimus one.

const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const LABEL = /^[\w.-]{1,64}$/;
const PARAM_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_BODY_BYTES = 16 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readLimited(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function parseRpcRequest(body: unknown): RpcRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const params = b.params;
  if (typeof b.tenantId !== "string" || !b.tenantId || b.tenantId.length > 100) return null;
  if (typeof b.connectorLabel !== "string" || !LABEL.test(b.connectorLabel)) return null;
  if (typeof b.sistema !== "string" || !NAME.test(b.sistema) || typeof b.consulta !== "string" || !NAME.test(b.consulta)) return null;
  if (typeof b.timeoutMs !== "number" || !Number.isInteger(b.timeoutMs) || b.timeoutMs < 1000 || b.timeoutMs > 60000) return null;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return null;
  const entries = Object.entries(params as Record<string, unknown>);
  if (entries.length > 10 || !entries.every(([k, v]) => PARAM_KEY.test(k) && typeof v === "string" && v.length <= 200)) return null;
  return {
    tenantId: b.tenantId, connectorLabel: b.connectorLabel, sistema: b.sistema, consulta: b.consulta,
    params: Object.fromEntries(entries) as Record<string, string>, timeoutMs: b.timeoutMs,
  };
}

export async function handleRpcQuery(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { broker: RpcBroker; rpcSecret: string },
): Promise<void> {
  if (!deps.rpcSecret) {
    send(res, 404, { detail: "rpc_desligado" });
    return;
  }
  if (!authorized(req, deps.rpcSecret)) {
    send(res, 401, { detail: "nao_autorizado" });
    return;
  }
  let request: RpcRequest | null = null;
  try {
    const raw = await readLimited(req);
    request = raw === null ? null : parseRpcRequest(JSON.parse(raw));
  } catch {
    request = null;
  }
  if (!request) {
    send(res, 422, { detail: "pedido_invalido" });
    return;
  }
  const result = await deps.broker.query(request);
  send(res, result.status, result.body);
}
