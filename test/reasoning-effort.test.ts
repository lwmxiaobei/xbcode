import test from "node:test";
import assert from "node:assert/strict";

import { streamChatCompletion, streamResponse } from "../src/agent/streams.js";
import type { UiBridge } from "../src/types.js";

function buildBridge(): UiBridge {
  return {
    appendAssistantDelta() {},
    appendThinkingDelta() {},
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool() {},
    updateUsage() {},
    noteStreamActivity() {},
    requestToolApproval: async () => "approved",
    requestUserChoice: async (questions) => questions.map((question) => [question.options[0]?.label ?? ""]),
  };
}

test("streamResponse sends reasoning.effort when configured", async () => {
  let received: any;
  const client = {
    responses: {
      stream(params: any) {
        received = params;
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hi" };
          },
          async finalResponse() {
            return {
              id: "resp_1",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          },
        };
      },
    },
  };

  await streamResponse(
    client as any,
    "gpt-5",
    "system",
    false,
    [{ type: "message", role: "user", content: [{ type: "input_text", text: "question" }] }],
    undefined,
    buildBridge(),
    [],
    undefined,
    undefined,
    "main",
    "high",
  );

  assert.deepEqual(received.reasoning, { effort: "high" });
});

test("streamChatCompletion sends reasoning_effort when configured", async () => {
  let received: any;
  const client = {
    chat: {
      completions: {
        async create(params: any) {
          received = params;
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "hi" } }] };
            },
          };
        },
      },
    },
  };

  const message = await streamChatCompletion(
    client as any,
    "gpt-5",
    "system",
    [{ role: "user", content: "question" }],
    buildBridge(),
    [],
    false,
    undefined,
    undefined,
    "main",
    "high",
  );

  assert.equal(received.reasoning_effort, "high");
  assert.equal(message.content, "hi");
});
