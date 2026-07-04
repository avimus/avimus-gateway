import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConnectionRegistry } from "../ws/connectionRegistry";
import type { MessageQueue } from "../queue/messageQueue";
import type { Logger } from "../logging/logger";
import { isAuthorized } from "./internalAuth";
import { auditLog } from "../logging/auditLog";

export interface MetricsDeps {
  registry: ConnectionRegistry;
  queue: MessageQueue;
  internalSecret: string;
  logger: Logger;
}

interface TenantMetrics {
  tenantId: string;
  activeConnections: number;
  queuedMessages: number;
  lastActivityAt: string | null;
}

function latestActivity(tenantId: string, registry: ConnectionRegistry): string | null {
  const connections = registry.connectionsForTenant(tenantId);
  if (connections.length === 0) return null;
  const latest = connections.reduce((a, b) => (a.lastActivityAt > b.lastActivityAt ? a : b));
  return latest.lastActivityAt.toISOString();
}

export function handleMetrics(req: IncomingMessage, res: ServerResponse, deps: MetricsDeps): void {
  if (!isAuthorized(req, deps.internalSecret)) {
    auditLog(deps.logger, "metrics_access_denied", {});
    res.statusCode = 401;
    res.end();
    return;
  }

  const tenantIds = new Set([...deps.registry.tenantIds(), ...deps.queue.tenantIds()]);
  const tenants: TenantMetrics[] = [...tenantIds].map((tenantId) => ({
    tenantId,
    activeConnections: deps.registry.countForTenant(tenantId),
    queuedMessages: deps.queue.sizeForTenant(tenantId),
    lastActivityAt: latestActivity(tenantId, deps.registry),
  }));

  res.statusCode = 200;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ tenants }));
}
