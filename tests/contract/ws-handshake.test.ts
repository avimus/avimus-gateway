import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildTestConfig, startTestApp, type RunningTestApp } from "../helpers/testApp";
import { startStubAvimusApi } from "../helpers/stubAvimusApi";
import { makeToken } from "../helpers/token";
import { waitForOpenOrClose, MessageCollector } from "../helpers/wsClient";

const SECRET = "test-secret";

async function setup(): Promise<RunningTestApp> {
  return startTestApp(buildTestConfig({ GATEWAY_JWT_SECRET: SECRET }));
}

function connect(wsUrl: string, token: string, extraQuery = ""): WebSocket {
  return new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}${extraQuery}`);
}

function waitForUnexpectedResponse(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("open", () => reject(new Error("expected rejection, but connection opened")));
  });
}

test("valid token: auth_ok is the first frame received", async () => {
  const running = await setup();
  try {
    const token = makeToken(SECRET);
    const ws = connect(running.wsUrl, token);
    const collector = new MessageCollector(ws);
    const opened = await waitForOpenOrClose(ws);
    assert.equal(opened.event, "open");
    const first = await collector.next();
    assert.equal(first.type, "auth_ok");
    assert.equal(first.tenantId, "hosp-1");
    ws.close();
  } finally {
    await running.close();
  }
});

test("expired token is rejected with HTTP 401 before upgrade", async () => {
  const running = await setup();
  try {
    const token = makeToken(SECRET, {}, { expiresIn: -1 });
    const ws = connect(running.wsUrl, token);
    const status = await waitForUnexpectedResponse(ws);
    assert.equal(status, 401);
  } finally {
    await running.close();
  }
});

test("invalid signature is rejected with HTTP 401 before upgrade", async () => {
  const running = await setup();
  try {
    const token = makeToken("wrong-secret");
    const ws = connect(running.wsUrl, token);
    const status = await waitForUnexpectedResponse(ws);
    assert.equal(status, 401);
  } finally {
    await running.close();
  }
});

test("revoked token is rejected with HTTP 403 before upgrade", async () => {
  const running = await setup();
  try {
    const jti = "jti-revoked";
    running.app.revocationList.revoke(jti);
    const token = makeToken(SECRET, { jti });
    const ws = connect(running.wsUrl, token);
    const status = await waitForUnexpectedResponse(ws);
    assert.equal(status, 403);
  } finally {
    await running.close();
  }
});

test("incompatible protocol major version is rejected with HTTP 403", async () => {
  const running = await setup();
  try {
    const token = makeToken(SECRET);
    const ws = connect(running.wsUrl, token, "&version=2.0.0");
    const status = await waitForUnexpectedResponse(ws);
    assert.equal(status, 403);
  } finally {
    await running.close();
  }
});

test("missing token is rejected with HTTP 401", async () => {
  const running = await setup();
  try {
    const ws = new WebSocket(running.wsUrl);
    const status = await waitForUnexpectedResponse(ws);
    assert.equal(status, 401);
  } finally {
    await running.close();
  }
});

test("production: plain ws:// is rejected with HTTP 400 when no proxy header claims https", async () => {
  const running = await startTestApp(buildTestConfig({ NODE_ENV: "production" }));
  try {
    const token = makeToken(SECRET);
    const ws = connect(running.wsUrl, token);
    const status = await waitForUnexpectedResponse(ws);
    assert.equal(status, 400);
  } finally {
    await running.close();
  }
});

test("production: cf-visitor scheme=https is trusted even when x-forwarded-proto lies (SnapDeploy quirk)", async () => {
  const running = await startTestApp(buildTestConfig({ NODE_ENV: "production" }));
  try {
    const token = makeToken(SECRET);
    const ws = new WebSocket(`${running.wsUrl}?token=${encodeURIComponent(token)}`, {
      headers: { "x-forwarded-proto": "http", "cf-visitor": '{"scheme":"https"}' },
    });
    const collector = new MessageCollector(ws);
    const opened = await waitForOpenOrClose(ws);
    assert.equal(opened.event, "open");
    const first = await collector.next();
    assert.equal(first.type, "auth_ok");
    ws.close();
  } finally {
    await running.close();
  }
});

test("opaque hst_ token in Authorization header is validated against the Avimus API", async () => {
  const avimus = await startStubAvimusApi();
  avimus.validateTokenResponse = { valid: true, tenantId: "hosp-opaque", erpName: "tasy" };
  const running = await startTestApp(buildTestConfig({ AVIMUS_API_URL: avimus.baseUrl }));
  try {
    const ws = new WebSocket(running.wsUrl, { headers: { Authorization: "Bearer hst_abc123" } });
    const collector = new MessageCollector(ws);
    const opened = await waitForOpenOrClose(ws);
    assert.equal(opened.event, "open");
    const first = await collector.next();
    assert.equal(first.type, "auth_ok");
    assert.equal(first.tenantId, "hosp-opaque");

    assert.equal(avimus.validateTokenRequests.length, 1);
    assert.equal(avimus.validateTokenRequests[0]?.authorization, "Bearer hst_abc123");
    assert.equal(avimus.validateTokenRequests[0]?.internalSecret, "test-internal-secret");
    ws.close();
  } finally {
    await running.close();
    await avimus.close();
  }
});

test("opaque hst_ token rejected by the Avimus API gets HTTP 401", async () => {
  const avimus = await startStubAvimusApi();
  avimus.validateTokenResponse = { valid: false, tenantId: "", erpName: "" };
  const running = await startTestApp(buildTestConfig({ AVIMUS_API_URL: avimus.baseUrl }));
  try {
    const ws = new WebSocket(running.wsUrl, { headers: { Authorization: "Bearer hst_bad" } });
    const status = await waitForUnexpectedResponse(ws);
    assert.equal(status, 401);
  } finally {
    await running.close();
    await avimus.close();
  }
});
