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

test("does not submit on multi-line paste (newline followed by more text)", () => {
  // 多行粘贴：旧实现会把第一行截下来自动提交，剩余的留在输入框。
  // 现在应该统一返回 null，让 TextInput 接管，不要触发提交。
  assert.equal(getSubmittedValueFromInput("", "line1\nline2", false), null);
  assert.equal(getSubmittedValueFromInput("", "line1\r\nline2\r\nline3", false), null);
  assert.equal(getSubmittedValueFromInput("prefix-", "a\nb", false), null);
});

test("submits when paste ends with trailing newline only", () => {
  // 末尾换行（如 "/exit\r\n"）仍然算 Enter 兜底，应当提交。
  assert.equal(getSubmittedValueFromInput("", "/exit\r\n", false), "/exit");
  assert.equal(getSubmittedValueFromInput("", "\r", false), "");
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
