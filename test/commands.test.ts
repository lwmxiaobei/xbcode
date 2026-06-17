import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCommand, parseStartupCommand, submissionNeedsSelectedModel } from "../src/commands.js";

test("normalizeCommand keeps built-in commands that carry trailing arguments", () => {
  assert.equal(normalizeCommand("/provider openai"), "provider openai");
  assert.equal(normalizeCommand("/model gpt-5"), "model gpt-5");
  assert.equal(normalizeCommand("/MODEL GPT-5"), "model gpt-5");
  assert.equal(normalizeCommand("/login openai"), "login openai");
  assert.equal(normalizeCommand("/logout openai"), "logout openai");
  assert.equal(normalizeCommand("/resume 20260422-abcd12"), "resume 20260422-abcd12");
});

test("normalizeCommand still aliases quit to exit", () => {
  assert.equal(normalizeCommand("/quit"), "exit");
});

test("normalizeCommand recognizes /usage as a built-in command", () => {
  assert.equal(normalizeCommand("/usage"), "usage");
  assert.equal(normalizeCommand("/USAGE"), "usage");
  // 没有 "/" 前缀的纯文本不应该被吞成命令，避免误吞普通对话
  assert.equal(normalizeCommand("usage"), null);
});

test("normalizeCommand preserves goal objective casing and spacing", () => {
  assert.equal(normalizeCommand("/goal Build OAuth API"), "goal Build OAuth API");
  assert.equal(normalizeCommand("/GOAL   Build OAuth API"), "goal Build OAuth API");
});

test("normalizeCommand returns null for unknown slash commands", () => {
  assert.equal(normalizeCommand("/does-not-exist"), null);
});

test("normalizeCommand does not treat bare text as a built-in command", () => {
  assert.equal(normalizeCommand("provider openai"), null);
  assert.equal(normalizeCommand("login openai"), null);
  assert.equal(normalizeCommand("logout openai"), null);
  assert.equal(normalizeCommand("logout帮我清理下旧会话状态"), null);
});

test("parseStartupCommand recognizes resume invocations from argv", () => {
  assert.deepEqual(parseStartupCommand(["resume", "20260422-abcd12"]), {
    kind: "resume",
    sessionId: "20260422-abcd12",
  });
  assert.deepEqual(parseStartupCommand(["resume"]), {
    kind: "resume",
    sessionId: undefined,
  });
});

test("parseStartupCommand falls back to default for unknown argv", () => {
  assert.deepEqual(parseStartupCommand([]), { kind: "default" });
  assert.deepEqual(parseStartupCommand(["hello"]), { kind: "default" });
});

test("submissionNeedsSelectedModel only flags inputs that would start a turn", () => {
  assert.equal(submissionNeedsSelectedModel("hello"), true);
  assert.equal(submissionNeedsSelectedModel("/help"), false);
  assert.equal(submissionNeedsSelectedModel("/model"), false);
  assert.equal(submissionNeedsSelectedModel("/resume 20260422-abcd12"), false);
  assert.equal(submissionNeedsSelectedModel("/unknown"), false);
  assert.equal(submissionNeedsSelectedModel("/skill foo", true), true);
});
