export type InboundMessage =
  | { type: "heartbeat"; version: string; timestamp: string }
  | {
      type: "event";
      erpName: string;
      eventCode: string;
      cpf: string;
      eventDate: string;
      metadata: Record<string, unknown>;
    }
  | { type: "auth_refresh"; token: string };

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
    case "event": {
      if (
        typeof msg.erpName !== "string" ||
        typeof msg.eventCode !== "string" ||
        typeof msg.cpf !== "string" ||
        typeof msg.eventDate !== "string"
      ) {
        throw new MessageValidationError("event requires erpName, eventCode, cpf, eventDate");
      }
      const metadata =
        typeof msg.metadata === "object" && msg.metadata !== null
          ? (msg.metadata as Record<string, unknown>)
          : {};
      return {
        type: "event",
        erpName: msg.erpName,
        eventCode: msg.eventCode,
        cpf: msg.cpf,
        eventDate: msg.eventDate,
        metadata,
      };
    }
    case "auth_refresh": {
      if (typeof msg.token !== "string") {
        throw new MessageValidationError("auth_refresh requires token");
      }
      return { type: "auth_refresh", token: msg.token };
    }
    default:
      throw new MessageValidationError(`unrecognized message type: ${String(msg.type)}`);
  }
}
