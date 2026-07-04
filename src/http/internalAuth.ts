import type { IncomingMessage } from "node:http";

export function isAuthorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers["x-internal-secret"];
  return typeof header === "string" && header === secret;
}
