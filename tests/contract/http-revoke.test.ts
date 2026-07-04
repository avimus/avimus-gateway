import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestConfig, startTestApp } from "../helpers/testApp";

const SECRET_HEADER = "x-internal-secret";
const INTERNAL_SECRET = "top-secret";

async function postRevoke(baseUrl: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/admin/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("POST /admin/revoke without the secret header is denied and revokes nothing", async () => {
  const running = await startTestApp(buildTestConfig({ AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET }));
  try {
    const res = await postRevoke(running.baseUrl, { jti: "jti-1" });
    assert.equal(res.status, 401);
    assert.equal(running.app.revocationList.isRevoked("jti-1"), false);
  } finally {
    await running.close();
  }
});

test("POST /admin/revoke with the correct header revokes a known jti", async () => {
  const running = await startTestApp(buildTestConfig({ AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET }));
  try {
    const res = await postRevoke(
      running.baseUrl,
      { jti: "jti-2" },
      { [SECRET_HEADER]: INTERNAL_SECRET },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { revoked: boolean; jti: string };
    assert.equal(body.revoked, true);
    assert.equal(body.jti, "jti-2");
    assert.equal(running.app.revocationList.isRevoked("jti-2"), true);
  } finally {
    await running.close();
  }
});

test("POST /admin/revoke for a jti with no active connection still records the revocation", async () => {
  const running = await startTestApp(buildTestConfig({ AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET }));
  try {
    const res = await postRevoke(
      running.baseUrl,
      { jti: "jti-never-connected" },
      { [SECRET_HEADER]: INTERNAL_SECRET },
    );
    assert.equal(res.status, 200);
    assert.equal(running.app.revocationList.isRevoked("jti-never-connected"), true);
  } finally {
    await running.close();
  }
});

test("POST /admin/revoke with a missing jti is a bad request", async () => {
  const running = await startTestApp(buildTestConfig({ AVIMUS_INTERNAL_SECRET: INTERNAL_SECRET }));
  try {
    const res = await postRevoke(running.baseUrl, {}, { [SECRET_HEADER]: INTERNAL_SECRET });
    assert.equal(res.status, 400);
  } finally {
    await running.close();
  }
});
