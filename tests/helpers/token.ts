import jwt from "jsonwebtoken";

export interface TokenOverrides {
  tenantId?: string;
  erpName?: string;
  label?: string;
  jti?: string;
}

let counter = 0;

export function makeToken(
  secret: string,
  overrides: TokenOverrides = {},
  signOptions: jwt.SignOptions = {},
): string {
  counter += 1;
  const payload = {
    tenantId: "hosp-1",
    erpName: "tasy",
    label: "unidade-centro",
    jti: `jti-${counter}`,
    ...overrides,
  };
  return jwt.sign(payload, secret, { algorithm: "HS256", expiresIn: "90d", ...signOptions });
}
