import { sendMessage } from "./protocol";
import type { ConnectionRegistry } from "./connectionRegistry";

/** Notifies and disconnects every active connection using the given jti. Returns the count affected. */
export function broadcastRevocation(jti: string, registry: ConnectionRegistry): number {
  const connections = registry.findByJti(jti);
  for (const connection of connections) {
    sendMessage(connection.socket, { type: "revoked", reason: "credential revoked by operations" });
    connection.socket.close();
  }
  return connections.length;
}
