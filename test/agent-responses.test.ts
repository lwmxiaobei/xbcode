import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAssistantTextFromResponseOutput,
  getMissingAssistantText,
  shouldPreserveChatReasoningContent,
} from "../src/agent.js";

test("extractAssistantTextFromResponseOutput recovers assistant text from message output items", () => {
  const output = [
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "先读 diff，" },
        { type: "output_text", text: "再给 review 结论。" },
      ],
    },
    {
      type: "function_call",
      name: "task",
      arguments: "{}",
    },
  ];

  assert.equal(extractAssistantTextFromResponseOutput(output), "先读 diff，再给 review 结论。");
});

test("getMissingAssistantText returns the whole final text when no delta was streamed", () => {
  assert.equal(getMissingAssistantText("", "先说明计划，再调用工具。"), "先说明计划，再调用工具。");
});

test("getMissingAssistantText returns only the missing suffix when streamed text is a prefix", () => {
  assert.equal(getMissingAssistantText("先说明计划", "先说明计划，再调用工具。"), "，再调用工具。");
});

test("getMissingAssistantText avoids duplicates when streamed text already matches final text", () => {
  assert.equal(getMissingAssistantText("先说明计划，再调用工具。", "先说明计划，再调用工具。"), "");
});

test("getMissingAssistantText falls back to the final text when streamed text diverges", () => {
  assert.equal(getMissingAssistantText("先说明", "我先说明计划，再调用工具。"), "我先说明计划，再调用工具。");
});

test("shouldPreserveChatReasoningContent keeps thinking payloads only for models that require replay", () => {
  assert.equal(shouldPreserveChatReasoningContent("mimo-v2.5-pro", true), true);
  assert.equal(shouldPreserveChatReasoningContent("gpt-5.4", true), false);
  assert.equal(shouldPreserveChatReasoningContent("mimo-v2.5-pro", false), false);
});
