import test from "node:test";
import assert from "node:assert/strict";

import { debugLog } from "../src/utils.js";

test("debugLog is silent when DEBUG is not enabled", () => {
  const originalDebug = process.env.DEBUG;
  const originalWrite = process.stderr.write;
  const writes: string[] = [];

  process.env.DEBUG = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    debugLog("hidden", { step: 1 });
    assert.deepEqual(writes, []);
  } finally {
    process.env.DEBUG = originalDebug;
    process.stderr.write = originalWrite;
  }
});

test("debugLog writes formatted output to stderr when DEBUG=1", () => {
  const originalDebug = process.env.DEBUG;
  const originalWrite = process.stderr.write;
  const writes: string[] = [];

  process.env.DEBUG = "1";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    debugLog("visible", { step: 2 });
    assert.equal(writes.length, 1);
    assert.match(writes[0] ?? "", /^\[debug\] visible \{ step: 2 \}\n$/);
  } finally {
    process.env.DEBUG = originalDebug;
    process.stderr.write = originalWrite;
  }
});
