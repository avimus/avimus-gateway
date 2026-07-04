import jwt from "jsonwebtoken";

export interface GatewayTokenPayload {
  tenantId: string;
  erpName: string;
  label: string;
  jti: string;
  iat: number;
  exp: number;
}

export class TokenValidationError extends Error {
  constructor(
    public readonly code: 401 | 403,
    message: string,
  ) {
    super(message);
    this.name = "TokenValidationError";
  }
}

function hasRequiredFields(decoded: unknown): decoded is GatewayTokenPayload {
  if (typeof decoded !== "object" || decoded === null) return false;
  const payload = decoded as Record<string, unknown>;
  return (
    typeof payload.tenantId === "string" &&
    typeof payload.erpName === "string" &&
    typeof payload.label === "string" &&
    typeof payload.jti === "string"
  );
}

/** Verifies signature, algorithm, and expiration. Does not check revocation. */
export function verifyToken(token: string, secret: string): GatewayTokenPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new TokenValidationError(401, "token expired");
    }
    throw new TokenValidationError(401, "invalid token");
  }

  if (!hasRequiredFields(decoded)) {
    throw new TokenValidationError(401, "token payload missing required fields");
  }
  return decoded;
}
