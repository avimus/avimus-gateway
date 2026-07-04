import axios, { type AxiosInstance } from "axios";

export interface HeartbeatForward {
  tenantId: string;
  version: string;
  timestamp: string;
}

export interface EventForward {
  tenantId: string;
  erpName: string;
  eventCode: string;
  cpf: string;
  eventDate: string;
  metadata: Record<string, unknown>;
}

export interface OfflineNotification {
  tenantId: string;
  status: "offline";
}

const DEFAULT_TIMEOUT_MS = 5000;

/** Thrown (via axios rejection) on any network error, timeout, or non-2xx response. */
export class AvimusClient {
  private readonly http: AxiosInstance;

  constructor(baseURL: string, internalSecret: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.http = axios.create({
      baseURL,
      timeout: timeoutMs,
      headers: { "x-internal-secret": internalSecret },
    });
  }

  async sendHeartbeat(payload: HeartbeatForward | OfflineNotification): Promise<void> {
    await this.http.post("/api/v1/internal/heartbeat", payload);
  }

  async sendEvent(payload: EventForward): Promise<void> {
    await this.http.post("/api/v1/internal/events", payload);
  }
}
