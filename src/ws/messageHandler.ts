import { randomUUID } from "node:crypto";
import type { InboundMessage } from "./messageSchema";
import { sendMessage } from "./protocol";
import type { HospitalConnection } from "./connectionRegistry";
import type { AvimusClient } from "../avimus-client/client";
import type { Logger } from "../logging/logger";
import { maskCpf } from "../logging/maskCpf";
import type { MessageQueue, QueuedMessage } from "../queue/messageQueue";
import { flushQueue } from "../queue/replay";

export interface MessageHandlerDeps {
  avimusClient: AvimusClient;
  logger: Logger;
  queue: MessageQueue;
}

type ApplicationMessage = Extract<InboundMessage, { type: "heartbeat" | "event" }>;

function toQueuedMessage(
  messageId: string,
  tenantId: string,
  tenantToken: string,
  message: ApplicationMessage,
): QueuedMessage {
  if (message.type === "heartbeat") {
    return {
      messageId,
      kind: "heartbeat",
      payload: { tenantId, version: message.version, timestamp: message.timestamp },
      tenantToken,
      queuedAt: new Date(),
    };
  }
  return {
    messageId,
    kind: "event",
    payload: {
      tenantId,
      erpName: message.erpName,
      eventCode: message.eventCode,
      cpf: message.cpf,
      eventDate: message.eventDate,
      metadata: message.metadata,
    },
    tenantToken,
    queuedAt: new Date(),
  };
}

async function deliverLive(
  tenantId: string,
  tenantToken: string,
  message: ApplicationMessage,
  deps: MessageHandlerDeps,
): Promise<void> {
  if (message.type === "heartbeat") {
    await deps.avimusClient.sendHeartbeat(
      {
        tenantId,
        version: message.version,
        timestamp: message.timestamp,
      },
      tenantToken,
    );
    return;
  }
  deps.logger.info(
    { tenantId, eventCode: message.eventCode, cpf: maskCpf(message.cpf) },
    "forwarding event",
  );
  // The CPF forwarded to Avimus stays unmasked — masking only applies to log output (FR-014).
  await deps.avimusClient.sendEvent(
    {
      tenantId,
      erpName: message.erpName,
      eventCode: message.eventCode,
      cpf: message.cpf,
      eventDate: message.eventDate,
      metadata: message.metadata,
    },
    tenantToken,
  );
}

/** Handles `heartbeat` and `event` messages: forward to Ávimus, then ack or error. */
export async function handleApplicationMessage(
  connection: HospitalConnection,
  message: ApplicationMessage,
  deps: MessageHandlerDeps,
): Promise<void> {
  const messageId = randomUUID();
  connection.lastActivityAt = new Date();
  const { tenantId, jti: tenantToken } = connection;

  if (deps.queue.hasQueued(tenantId)) {
    // A backlog already exists for this tenant: append behind it rather than
    // racing ahead, then try to flush the whole backlog (this message
    // included) — this is what eventually clears holding mode once Avimus is
    // reachable again, without needing a background retry timer.
    deps.queue.enqueue(tenantId, toQueuedMessage(messageId, tenantId, tenantToken, message));
    flushQueue(tenantId, deps.queue, deps.avimusClient).catch((err: unknown) => {
      deps.logger.error({ tenantId, err }, "unexpected error flushing queued messages");
    });
    sendMessage(connection.socket, { type: "ack", messageId, status: "received" });
    return;
  }

  try {
    await deliverLive(tenantId, tenantToken, message, deps);
    sendMessage(connection.socket, { type: "ack", messageId, status: "received" });
  } catch (err) {
    deps.logger.warn({ tenantId, err }, "failed to forward message to Avimus; holding for retry");
    deps.queue.enqueue(tenantId, toQueuedMessage(messageId, tenantId, tenantToken, message));
    sendMessage(connection.socket, { type: "ack", messageId, status: "received" });
  }
}
