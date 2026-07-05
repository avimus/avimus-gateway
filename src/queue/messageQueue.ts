import type { HeartbeatForward, EventForward } from "../avimus-client/client";

export interface QueuedMessage {
  messageId: string;
  kind: "heartbeat" | "event";
  payload: HeartbeatForward | EventForward;
  tenantToken: string;
  queuedAt: Date;
}

/**
 * Per-tenant bounded, in-order message queue. Oldest message is dropped when
 * a tenant's queue is already at capacity (FR-008) — in memory only, per
 * constitution Principle V.
 */
export class MessageQueue {
  private readonly byTenant = new Map<string, QueuedMessage[]>();

  constructor(private readonly capacity: number) {}

  enqueue(tenantId: string, message: QueuedMessage): void {
    let queue = this.byTenant.get(tenantId);
    if (!queue) {
      queue = [];
      this.byTenant.set(tenantId, queue);
    }
    if (queue.length >= this.capacity) {
      queue.shift();
    }
    queue.push(message);
  }

  /** Removes and returns all queued messages for a tenant, in order. */
  drain(tenantId: string): QueuedMessage[] {
    const queue = this.byTenant.get(tenantId) ?? [];
    this.byTenant.delete(tenantId);
    return queue;
  }

  /**
   * Puts an undelivered batch back at the front of the queue (older than
   * anything enqueued since), re-applying the capacity limit.
   */
  restore(tenantId: string, messages: QueuedMessage[]): void {
    if (messages.length === 0) return;
    const arrivedDuringReplay = this.byTenant.get(tenantId) ?? [];
    const combined = [...messages, ...arrivedDuringReplay];
    const trimmed =
      combined.length > this.capacity ? combined.slice(combined.length - this.capacity) : combined;
    this.byTenant.set(tenantId, trimmed);
  }

  hasQueued(tenantId: string): boolean {
    return (this.byTenant.get(tenantId)?.length ?? 0) > 0;
  }

  sizeForTenant(tenantId: string): number {
    return this.byTenant.get(tenantId)?.length ?? 0;
  }

  tenantIds(): string[] {
    return [...this.byTenant.keys()];
  }
}
