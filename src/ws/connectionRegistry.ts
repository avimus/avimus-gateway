import type WebSocket from "ws";

export interface HospitalConnection {
  tenantId: string;
  erpName: string;
  label: string;
  jti: string;
  socket: WebSocket;
  protocolVersion: string;
  connectedAt: Date;
  lastActivityAt: Date;
}

export const MAX_CONNECTIONS_PER_TENANT = 10;

export class ConnectionLimitExceededError extends Error {
  constructor(tenantId: string) {
    super(`tenant ${tenantId} already has ${MAX_CONNECTIONS_PER_TENANT} active connections`);
    this.name = "ConnectionLimitExceededError";
  }
}

/** In-memory registry of active hospital connections, per constitution Principle V. */
export class ConnectionRegistry {
  private readonly byTenant = new Map<string, Set<HospitalConnection>>();

  /** Throws ConnectionLimitExceededError if the tenant is already at the limit. */
  add(connection: HospitalConnection): void {
    let set = this.byTenant.get(connection.tenantId);
    if (!set) {
      set = new Set();
      this.byTenant.set(connection.tenantId, set);
    }
    if (set.size >= MAX_CONNECTIONS_PER_TENANT) {
      throw new ConnectionLimitExceededError(connection.tenantId);
    }
    set.add(connection);
  }

  remove(connection: HospitalConnection): void {
    const set = this.byTenant.get(connection.tenantId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) {
      this.byTenant.delete(connection.tenantId);
    }
  }

  findByJti(jti: string): HospitalConnection[] {
    const matches: HospitalConnection[] = [];
    for (const set of this.byTenant.values()) {
      for (const connection of set) {
        if (connection.jti === jti) matches.push(connection);
      }
    }
    return matches;
  }

  countForTenant(tenantId: string): number {
    return this.byTenant.get(tenantId)?.size ?? 0;
  }

  totalConnections(): number {
    let total = 0;
    for (const set of this.byTenant.values()) total += set.size;
    return total;
  }

  tenantIds(): string[] {
    return [...this.byTenant.keys()];
  }

  connectionsForTenant(tenantId: string): HospitalConnection[] {
    return [...(this.byTenant.get(tenantId) ?? [])];
  }

  allConnections(): HospitalConnection[] {
    const all: HospitalConnection[] = [];
    for (const set of this.byTenant.values()) all.push(...set);
    return all;
  }
}
