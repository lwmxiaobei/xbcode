import assert from "node:assert/strict";
import test from "node:test";

import { createSubmitDeduper, getSubmittedValueFromInput } from "../src/input-submit.js";

test("extracts submitted value when enter arrives as a key event", () => {
  assert.equal(getSubmittedValueFromInput("/exit", "", true), "/exit");
});

test("extracts submitted value when text and newline arrive in one chunk", () => {
  assert.equal(getSubmittedValueFromInput("", "/exit\r", false), "/exit");
  assert.equal(getSubmittedValueFromInput("/he", "lp\n", false), "/help");
});

test("returns null when input chunk does not contain submit signal", () => {
  assert.equal(getSubmittedValueFromInput("/ex", "it", false), null);
});

test("blocks immediate duplicate submits for the same value", () => {
  const deduper = createSubmitDeduper(80);

  assert.equal(deduper.shouldSubmit("/exit"), true);
  assert.equal(deduper.shouldSubmit("/exit"), false);
});

test("allows a different value and allows the same value again after the window", async () => {
  const deduper = createSubmitDeduper(30);

  assert.equal(deduper.shouldSubmit("/help"), true);
  assert.equal(deduper.shouldSubmit("/exit"), true);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(deduper.shouldSubmit("/exit"), true);
});
