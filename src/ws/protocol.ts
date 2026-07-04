import type WebSocket from "ws";

export const GATEWAY_VERSION = "1.0.0";

export type OutboundMessage =
  | { type: "auth_ok"; tenantId: string; gatewayVersion: string }
  | { type: "auth_error"; reason: string; code: 401 | 403 }
  | { type: "ack"; messageId: string; status: "received" }
  | { type: "error"; messageId: string | null; reason: string; retryable: boolean }
  | { type: "revoked"; reason: string };

export function sendMessage(socket: WebSocket, message: OutboundMessage): void {
  socket.send(JSON.stringify(message));
}
