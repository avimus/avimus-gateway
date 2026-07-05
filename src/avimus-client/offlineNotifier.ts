import type { AvimusClient } from "./client";
import type { Logger } from "../logging/logger";

export interface OfflineNotifierDeps {
  avimusClient: AvimusClient;
  logger: Logger;
}

/**
 * Best-effort: an offline notice that fails to deliver is logged, not
 * queued. Unlike heartbeats/events, losing one doesn't corrupt the patient
 * journey — the hospital's next successful heartbeat re-establishes state.
 */
export async function notifyOffline(
  tenantId: string,
  tenantToken: string,
  deps: OfflineNotifierDeps,
): Promise<void> {
  try {
    await deps.avimusClient.sendHeartbeat({ tenantId, status: "offline" }, tenantToken);
  } catch (err) {
    deps.logger.warn({ tenantId, err }, "failed to notify Avimus of hospital going offline");
  }
}
