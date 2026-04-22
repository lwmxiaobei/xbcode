import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCommand } from "../src/commands.js";

test("normalizeCommand keeps built-in commands that carry trailing arguments", () => {
  assert.equal(normalizeCommand("/provider openai"), "provider openai");
  assert.equal(normalizeCommand("/model gpt-5"), "model gpt-5");
  assert.equal(normalizeCommand("/login openai"), "login openai");
  assert.equal(normalizeCommand("/logout openai"), "logout openai");
});

test("normalizeCommand still aliases quit to exit", () => {
  assert.equal(normalizeCommand("/quit"), "exit");
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
