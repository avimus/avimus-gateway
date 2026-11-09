export interface GatewayConfig {
  port: number;
  gatewayJwtSecret: string;
  avimusApiUrl: string;
  avimusInternalSecret: string;
  logLevel: string;
  maxQueuePerTenant: number;
  isProduction: boolean;
  /** POST /internal/rpc/query (worker → connector over the tunnel). Empty = route off. 32+ chars. */
  rpcSecret: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalIntEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative integer, got: ${raw}`);
  }
  return parsed;
}

function rpcSecret(env: NodeJS.ProcessEnv): string {
  const value = env.GATEWAY_RPC_SECRET ?? "";
  if (value && value.length < 32) throw new Error("GATEWAY_RPC_SECRET must have at least 32 characters");
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    port: optionalIntEnv(env, "PORT", 8080),
    gatewayJwtSecret: requireEnv(env, "GATEWAY_JWT_SECRET"),
    avimusApiUrl: requireEnv(env, "AVIMUS_API_URL"),
    avimusInternalSecret: requireEnv(env, "AVIMUS_INTERNAL_SECRET"),
    logLevel: env.LOG_LEVEL || "info",
    maxQueuePerTenant: optionalIntEnv(env, "MAX_QUEUE_PER_TENANT", 100),
    isProduction: env.NODE_ENV === "production",
    rpcSecret: rpcSecret(env),
  };
}
