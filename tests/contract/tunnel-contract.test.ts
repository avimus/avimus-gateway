import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInboundMessage, MessageValidationError } from "../../src/ws/messageSchema";

// Contract: specs/002-connector-rpc/contracts/tunnel.md (the same examples feed the health-socket tests).
const examples = JSON.parse(
  readFileSync(join(__dirname, "../../../specs/002-connector-rpc/contracts/tunnel-examples.json"), "utf8"),
) as { valid: Record<string, Record<string, unknown>>; invalid: Record<string, Record<string, unknown>> };

for (const name of ["heartbeat", "query.response", "query.error"]) {
  test(`tunnel contract: valid ${name} frame is accepted as-is`, () => {
    const parsed = parseInboundMessage(JSON.stringify(examples.valid[name]));
    assert.deepEqual(parsed, examples.valid[name]);
  });
}

for (const [name, frame] of Object.entries(examples.invalid)) {
  test(`tunnel contract: ${name} is refused`, () => {
    assert.throws(() => parseInboundMessage(JSON.stringify(frame)), MessageValidationError);
  });
}

test("tunnel contract: query.request is gateway → connector only, never accepted inbound", () => {
  assert.throws(() => parseInboundMessage(JSON.stringify(examples.valid["query.request"])), MessageValidationError);
});
