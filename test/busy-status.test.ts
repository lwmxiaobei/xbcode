import test from "node:test";
import assert from "node:assert/strict";

import { formatBusyStatus } from "../src/busy-status.js";

test("formatBusyStatus shows elapsed when no idle gap", () => {
  assert.equal(formatBusyStatus(0, 0), "Working 0s · Esc to stop");
  assert.equal(formatBusyStatus(5, 0), "Working 5s · Esc to stop");
  assert.equal(formatBusyStatus(12, 1), "Working 12s · Esc to stop");
});

test("formatBusyStatus surfaces idle gap once it crosses the threshold", () => {
  // 2s idle still considered active — within stream chunk jitter.
  assert.equal(formatBusyStatus(30, 2), "Working 30s · Esc to stop");
  // 5s+ idle should be shown so users can tell the stream stalled.
  assert.equal(formatBusyStatus(30, 5), "Working 30s · idle 5s · Esc to stop");
  assert.equal(formatBusyStatus(120, 60), "Working 120s · idle 60s · Esc to stop");
});

test("formatBusyStatus clamps negative inputs to zero", () => {
  assert.equal(formatBusyStatus(-1, -1), "Working 0s · Esc to stop");
});

test("formatBusyStatus floors fractional seconds", () => {
  assert.equal(formatBusyStatus(12.9, 0.4), "Working 12s · Esc to stop");
  assert.equal(formatBusyStatus(12.9, 7.8), "Working 12s · idle 7s · Esc to stop");
});
