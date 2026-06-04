import test from "node:test";
import assert from "node:assert/strict";

import { createIdleWatchdog, parseIdleTimeoutMs } from "../src/idle-watchdog.js";

test("watchdog signal fires after the configured timeout", async () => {
  const watchdog = createIdleWatchdog(30);
  watchdog.reset();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(watchdog.triggered, true);
  assert.equal(watchdog.signal.aborted, true);
});

test("reset() postpones the firing", async () => {
  const watchdog = createIdleWatchdog(40);
  watchdog.reset();
  await new Promise((r) => setTimeout(r, 20));
  watchdog.reset(); // 又活了 40ms
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(watchdog.triggered, false, "should not fire yet, still inside the second window");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(watchdog.triggered, true, "fires after the postponed window elapses");
});

test("disarm() prevents the watchdog from firing afterwards", async () => {
  const watchdog = createIdleWatchdog(20);
  watchdog.reset();
  watchdog.disarm();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(watchdog.triggered, false);
  assert.equal(watchdog.signal.aborted, false);
});

test("timeout <= 0 disables the watchdog entirely", async () => {
  const watchdog = createIdleWatchdog(0);
  watchdog.reset();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(watchdog.triggered, false);
});

test("parseIdleTimeoutMs defaults to 30s when unset or invalid", () => {
  assert.equal(parseIdleTimeoutMs(undefined), 30_000);
  assert.equal(parseIdleTimeoutMs(""), 30_000);
  assert.equal(parseIdleTimeoutMs("not-a-number"), 30_000);
  assert.equal(parseIdleTimeoutMs("0"), 0);
  assert.equal(parseIdleTimeoutMs("60000"), 60_000);
  // Negative is treated as "disabled" (=0), not as default.
  assert.equal(parseIdleTimeoutMs("-1"), 0);
});
