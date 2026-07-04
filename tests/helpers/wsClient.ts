import type WebSocket from "ws";

export function waitForOpenOrClose(
  ws: WebSocket,
): Promise<{ event: "open" } | { event: "close"; code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ event: "open" }));
    ws.once("close", (code, reason) => resolve({ event: "close", code, reason: reason.toString() }));
    ws.once("error", reject);
  });
}

export function waitForClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/**
 * Buffers incoming messages from the moment it's constructed, so a message
 * sent by the server immediately on connect (e.g. `auth_ok`) is never missed
 * while test code is still awaiting the `open` event.
 */
export class MessageCollector {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: Array<(msg: Record<string, unknown>) => void> = [];

  constructor(ws: WebSocket) {
    ws.on("message", (data) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(parsed);
      else this.queue.push(parsed);
    });
  }

  next(): Promise<Record<string, unknown>> {
    const buffered = this.queue.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
