import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { verifyToken, TokenValidationError } from "../../src/auth/verifyToken";

const SECRET = "test-secret";

function makeToken(overrides: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) {
  const payload = {
    tenantId: "hosp-1",
    erpName: "tasy",
    label: "unidade-centro",
    jti: "jti-123",
    ...overrides,
  };
  return jwt.sign(payload, SECRET, { algorithm: "HS256", expiresIn: "90d", ...opts });
}

test("verifies a valid token and returns its payload", () => {
  const token = makeToken();
  const payload = verifyToken(token, SECRET);
  assert.equal(payload.tenantId, "hosp-1");
  assert.equal(payload.jti, "jti-123");
});

test("rejects an expired token with code 401", () => {
  const token = makeToken({}, { expiresIn: -1 });
  assert.throws(
    () => verifyToken(token, SECRET),
    (err: unknown) => err instanceof TokenValidationError && err.code === 401,
  );
});

test("rejects a token signed with the wrong secret", () => {
  const token = jwt.sign({ tenantId: "hosp-1", erpName: "tasy", label: "x", jti: "j1" }, "wrong-secret", {
    algorithm: "HS256",
  });
  assert.throws(
    () => verifyToken(token, SECRET),
    (err: unknown) => err instanceof TokenValidationError && err.code === 401,
  );
});

test("rejects a token signed with a different algorithm", () => {
  // HS384 is a different algorithm than the pinned HS256; verify() with
  // algorithms:['HS256'] must refuse to accept it even with the right secret.
  const token = jwt.sign({ tenantId: "hosp-1", erpName: "tasy", label: "x", jti: "j1" }, SECRET, {
    algorithm: "HS384",
  });
  assert.throws(
    () => verifyToken(token, SECRET),
    (err: unknown) => err instanceof TokenValidationError && err.code === 401,
  );
});

test("rejects a token missing required payload fields", () => {
  const token = jwt.sign({ tenantId: "hosp-1" }, SECRET, { algorithm: "HS256" });
  assert.throws(
    () => verifyToken(token, SECRET),
    (err: unknown) => err instanceof TokenValidationError && err.code === 401,
  );
});
