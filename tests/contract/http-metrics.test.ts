import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTestConfig, startTestApp } from "../helpers/testApp";

const SECRET_HEADER = "x-internal-secret";

test("GET /metrics without the secret header is denied", async () => {
  const running = await startTestApp(buildTestConfig({ AVIMUS_INTERNAL_SECRET: "top-secret" }));
  try {
    const res = await fetch(`${running.baseUrl}/metrics`);
    assert.equal(res.status, 401);
  } finally {
    await running.close();
  }
});

test("GET /metrics with the correct secret header returns per-tenant detail", async () => {
  const running = await startTestApp(buildTestConfig({ AVIMUS_INTERNAL_SECRET: "top-secret" }));
  try {
    const res = await fetch(`${running.baseUrl}/metrics`, {
      headers: { [SECRET_HEADER]: "top-secret" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tenants: unknown[] };
    assert.deepEqual(body.tenants, []);
  } finally {
    await running.close();
  }
});

test("GET /metrics with an incorrect secret header is denied", async () => {
  const running = await startTestApp(buildTestConfig({ AVIMUS_INTERNAL_SECRET: "top-secret" }));
  try {
    const res = await fetch(`${running.baseUrl}/metrics`, {
      headers: { [SECRET_HEADER]: "wrong" },
    });
    assert.equal(res.status, 401);
  } finally {
    await running.close();
  }
});
