import type { MessageQueue, QueuedMessage } from "./messageQueue";
import type { AvimusClient, HeartbeatForward, EventForward } from "../avimus-client/client";

async function deliver(message: QueuedMessage, client: AvimusClient): Promise<void> {
  if (message.kind === "heartbeat") {
    await client.sendHeartbeat(message.payload as HeartbeatForward, message.tenantToken);
  } else {
    await client.sendEvent(message.payload as EventForward, message.tenantToken);
  }
}

/**
 * Attempts to flush a tenant's entire backlog to Avimus, oldest first. Stops
 * and restores the undelivered remainder (holding mode continues) on the
 * first failure. Returns true once the backlog is fully drained.
 */
export async function flushQueue(
  tenantId: string,
  queue: MessageQueue,
  avimusClient: AvimusClient,
): Promise<boolean> {
  const messages = queue.drain(tenantId);
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    try {
      await deliver(message, avimusClient);
    } catch {
      queue.restore(tenantId, messages.slice(i));
      return false;
    }
  }
  return true;
}
