import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ConnectionRegistry, HospitalConnection } from "../ws/connectionRegistry";
import type { Logger } from "../logging/logger";

// Request/response over the tunnel (contract: specs/002-connector-rpc/contracts/tunnel.md).
// No queue: if the connector is gone, the worker retries next cycle. Logs carry ids and codes only,
// never params or rows (they hold patient data).

export const MAX_PENDING_PER_CONNECTION = 4;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEADLINE_GRACE_MS = 1000;

export interface RpcRequest {
  tenantId: string;
  connectorLabel: string;
  sistema: string;
  consulta: string;
  params: Record<string, string>;
  timeoutMs: number;
}

export type RpcResult =
  | { status: 200; body: { sistema: string; consulta: string; quantidade: number; truncado: boolean; duracao_ms: number; dados: Record<string, unknown>[] } }
  | { status: number; body: { detail: string } };

type ResponseFrame = { type: "query.response"; requestId: string; page: number; last: boolean; truncado: boolean; duracaoMs: number; dados: Record<string, unknown>[] };
type ErrorFrame = { type: "query.error"; requestId: string; code: string; status: number };

interface Pending {
  request: RpcRequest;
  connection: HospitalConnection;
  nextPage: number;
  bytes: number;
  rows: Record<string, unknown>[];
  startedAt: number;
  timer: NodeJS.Timeout;
  finish: (result: RpcResult) => void;
}

const fail = (status: number, detail: string): RpcResult => ({ status, body: { detail } });

export class RpcBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly registry: ConnectionRegistry, private readonly logger: Logger) {}

  pendingCount(): number {
    return this.pending.size;
  }

  query(request: RpcRequest): Promise<RpcResult> {
    const candidates = this.registry
      .connectionsForTenant(request.tenantId)
      .filter((c) => c.label === request.connectorLabel && c.socket.readyState === WebSocket.OPEN)
      .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
    const connection = candidates.find((c) => this.inFlight(c) < MAX_PENDING_PER_CONNECTION);
    if (!connection) {
      const code = candidates.length ? "connector_busy" : "connector_offline";
      this.log(request, undefined, 503, code, 0);
      return Promise.resolve(fail(503, code));
    }

    const requestId = randomUUID();
    return new Promise<RpcResult>((resolve) => {
      const startedAt = Date.now();
      const finish = (result: RpcResult) => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        const quantidade = result.status === 200 ? (result.body as { quantidade: number }).quantidade : 0;
        this.log(request, requestId, result.status, result.status === 200 ? undefined : (result.body as { detail: string }).detail, quantidade, startedAt);
        resolve(result);
      };
      const timer = setTimeout(() => finish(fail(504, "connector_timeout")), request.timeoutMs + DEADLINE_GRACE_MS);
      this.pending.set(requestId, { request, connection, nextPage: 0, bytes: 0, rows: [], startedAt, timer, finish });
      try {
        connection.socket.send(JSON.stringify({
          type: "query.request", requestId, sistema: request.sistema, consulta: request.consulta,
          params: request.params, timeoutMs: request.timeoutMs,
        }));
      } catch {
        finish(fail(503, "connector_offline"));
      }
    });
  }

  /** A reply only counts from the very connection that got the request (another tenant's connector can't answer). */
  onFrame(connection: HospitalConnection, frame: ResponseFrame | ErrorFrame): void {
    const entry = this.pending.get(frame.requestId);
    if (!entry || entry.connection !== connection) {
      this.logger.debug({ tenantId: connection.tenantId, requestId: frame.requestId }, "rpc reply without pending request");
      return;
    }
    if (frame.type === "query.error") {
      entry.finish(fail(frame.status, frame.code));
      return;
    }
    if (frame.page !== entry.nextPage) {
      entry.finish(fail(502, "connector_protocol_error"));
      return;
    }
    entry.nextPage++;
    entry.bytes += Buffer.byteLength(JSON.stringify(frame.dados));
    if (entry.bytes > MAX_RESPONSE_BYTES) {
      entry.finish(fail(502, `${entry.request.sistema}_resposta_grande_demais`));
      return;
    }
    for (const row of frame.dados) entry.rows.push(row);
    if (frame.last) {
      entry.finish({
        status: 200,
        body: {
          sistema: entry.request.sistema, consulta: entry.request.consulta, quantidade: entry.rows.length,
          truncado: frame.truncado, duracao_ms: frame.duracaoMs, dados: entry.rows,
        },
      });
    }
  }

  /** The connector dropped: everything it owed fails now instead of waiting for the deadline. */
  onClose(connection: HospitalConnection): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.connection === connection) entry.finish(fail(503, "connector_offline"));
    }
  }

  private inFlight(connection: HospitalConnection): number {
    let n = 0;
    for (const entry of this.pending.values()) if (entry.connection === connection) n++;
    return n;
  }

  private log(request: RpcRequest, requestId: string | undefined, status: number, code: string | undefined, quantidade: number, startedAt?: number): void {
    this.logger.info({
      requestId, tenantId: request.tenantId, connectorLabel: request.connectorLabel, sistema: request.sistema,
      consulta: request.consulta, status, code, quantidade, ms: startedAt ? Date.now() - startedAt : 0,
    }, "rpc query");
  }
}
