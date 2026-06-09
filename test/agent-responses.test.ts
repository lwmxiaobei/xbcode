import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAssistantTextFromResponseOutput,
  getMissingAssistantText,
  runAgentTurn,
  shouldPreserveChatReasoningContent,
} from "../src/agent.js";
import type { AgentState, UiBridge } from "../src/types.js";

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

test("responses stream failure preserves interrupted turn for the next continue request", async () => {
  const assistantDeltas: string[] = [];
  const client = {
    responses: {
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.created", response: { id: "resp_interrupted" } };
            yield {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              delta: "我找到合适的 docs 位置了，准备新增文档。",
            };
            const cause = new Error("other side closed");
            cause.name = "SocketError";
            (cause as Error & { code?: string }).code = "UND_ERR_SOCKET";
            throw new TypeError("terminated", { cause });
          },
          async finalResponse() {
            throw new Error("final response should not be read after stream failure");
          },
        };
      },
    },
  };
  const state: AgentState = {
    sessionId: "session-test",
    previousResponseId: "resp_previous",
    responseHistory: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "前置上下文" }],
      },
    ],
    chatHistory: [],
    turnCount: 0,
    launchedAt: Date.now(),
    roundsSinceTask: 0,
    compactCount: 0,
  };
  const bridge: UiBridge = {
    appendAssistantDelta(delta) {
      assistantDeltas.push(delta);
    },
    appendThinkingDelta() {},
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool() {},
    updateUsage() {},
    noteStreamActivity() {},
    requestToolApproval: async () => "approved",
    requestUserChoice: async (questions) => questions.map((question) => [question.options[0]?.label ?? ""]),
  };

  await assert.rejects(
    () => runAgentTurn(
      {
        client: client as any,
        model: "gpt-5.4",
        system: "You are helpful.",
        showThinking: true,
        apiMode: "responses",
        supportsPreviousResponseId: true,
      },
      "请写 harness 架构文档",
      [],
      state,
      bridge,
    ),
    /\[main\] terminated/,
  );

  assert.equal(assistantDeltas.join(""), "我找到合适的 docs 位置了，准备新增文档。");
  assert.equal(state.previousResponseId, "resp_previous");
  assert.equal(state.responseHistory.length, 3);
  assert.deepEqual(state.responseHistory[1], {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "请写 harness 架构文档" }],
  });
  assert.deepEqual(state.responseHistory[2], {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "我找到合适的 docs 位置了，准备新增文档。" }],
  });
  assert.match(state.pendingCompactedContext ?? "", /请写 harness 架构文档/);
  assert.match(state.pendingCompactedContext ?? "", /我找到合适的 docs 位置了/);
  assert.match(state.pendingCompactedContext ?? "", /continue from the interrupted turn/i);
});
