import test from "node:test";
import assert from "node:assert/strict";

import { describeError } from "../src/error-log.js";

test("describeError includes nested transport cause details", () => {
  const cause = new Error("other side closed");
  cause.name = "SocketError";
  (cause as Error & { code?: string }).code = "UND_ERR_SOCKET";

  const error = new TypeError("terminated", { cause });

  const described = describeError(error);

  assert.equal(described.name, "TypeError");
  assert.equal(described.message, "terminated");
  assert.match(String(described.stack), /^TypeError: terminated/);
  assert.deepEqual(described.cause, {
    name: "SocketError",
    message: "other side closed",
    code: "UND_ERR_SOCKET",
    status: undefined,
    requestId: undefined,
    body: undefined,
    stack: (described.cause as { stack?: string }).stack,
  });
  assert.match(String((described.cause as { stack?: string }).stack), /^SocketError: other side closed/);
});

test("describeError protects log serialization from circular body values", () => {
  const body: Record<string, unknown> = { message: "bad gateway" };
  body.self = body;
  const error = Object.assign(new Error("502 upstream"), { status: 502, error: body });

  const described = describeError(error);

  assert.deepEqual(described.body, {
    message: "bad gateway",
    self: "[Circular]",
  });
  assert.doesNotThrow(() => JSON.stringify(described));
});
