import type { Logger } from "./logger";

/** Records a security-sensitive admin action (or a denied attempt) per FR-018. */
export function auditLog(logger: Logger, action: string, details: Record<string, unknown> = {}): void {
  logger.info({ audit: true, action, ...details }, "admin action");
}
