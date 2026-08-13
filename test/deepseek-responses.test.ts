import assert from "node:assert/strict";
import test from "node:test";

import { providerSupportsPreviousResponseId } from "../src/agent-client.js";
import { runAgentTurn } from "../src/agent.js";
import {
  buildResponseContinuation,
  collectReplayableResponseOutput,
} from "../src/agent/messages.js";
import {
  calculateCost,
  getContextWindow,
  getMaxOutputTokens,
  getPricingCurrency,
  resolveModelInfo,
} from "../src/agent/model-pricing.js";
import { accumulateTokenUsage, extractTokenUsage } from "../src/agent/usage.js";
import { streamChatCompletion } from "../src/agent/streams.js";
import { resolveApiMode } from "../src/config.js";
import { mcpManager } from "../src/mcp/runtime.js";
import { prepareResponseToolsForProvider } from "../src/tools.js";
import type { AgentState, UiBridge } from "../src/types.js";

test("both DeepSeek V4 models default to Responses while legacy models stay on Chat Completions", () => {
  assert.equal(
    resolveApiMode("https://api.deepseek.com", undefined, "deepseek-v4-flash"),
    "responses",
  );
  assert.equal(
    resolveApiMode("https://api.deepseek.com/v1", undefined, "deepseek-v4-pro"),
    "responses",
  );
  assert.equal(
    resolveApiMode("https://api.deepseek.com", undefined, "deepseek-chat"),
    "chat-completions",
  );
  assert.equal(
    resolveApiMode("https://api.deepseek.com", "chat-completions", "deepseek-v4-flash"),
    "chat-completions",
  );
  assert.equal(
    resolveApiMode("https://api.deepseek.com", "responses", "deepseek-v4-pro"),
    "responses",
  );
});

test("official DeepSeek Responses replaces local web search with the server tool", () => {
  const tools = [
    { type: "function", name: "bash" },
    { type: "function", name: "web_search" },
  ];

  assert.deepEqual(prepareResponseToolsForProvider(tools, {
    apiMode: "responses",
    baseURL: "https://api.deepseek.com",
  }), [
    { type: "function", name: "bash" },
    { type: "web_search" },
  ]);

  assert.deepEqual(prepareResponseToolsForProvider(tools, {
    apiMode: "chat-completions",
    baseURL: "https://api.deepseek.com",
  }), tools);

  assert.deepEqual(prepareResponseToolsForProvider(tools, {
    apiMode: "responses",
    baseURL: "https://api.openai.com/v1",
  }), tools);

  assert.deepEqual(prepareResponseToolsForProvider([
    { type: "function", name: "bash" },
  ], {
    apiMode: "responses",
    baseURL: "https://api.deepseek.com",
  }), [
    { type: "function", name: "bash" },
  ]);
});

test("official DeepSeek Responses endpoint is treated as stateless", () => {
  assert.equal(providerSupportsPreviousResponseId({
    apiMode: "responses",
    baseURL: "https://api.deepseek.com",
  }), false);
  assert.equal(providerSupportsPreviousResponseId({
    apiMode: "responses",
    baseURL: "https://api.openai.com/v1",
  }), true);
  assert.equal(providerSupportsPreviousResponseId({
    apiMode: "chat-completions",
    baseURL: "https://api.openai.com/v1",
  }), false);
});

test("stateless replay preserves DeepSeek reasoning and web search output items", () => {
  const reasoning = { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: "plan" }] };
  const webSearch = { type: "web_search_call", id: "ws_1", status: "completed" };
  const message = { type: "message", role: "assistant", content: [] };
  const ignored = { type: "computer_call", id: "computer_1" };

  const replayable = collectReplayableResponseOutput([reasoning, webSearch, message, ignored]);

  assert.deepEqual(replayable, [reasoning, webSearch, message]);
  assert.notEqual(replayable[0], reasoning);
});

test("response continuation replays full history for stateless providers", () => {
  const history = [{ type: "message", role: "user", content: "question" }];
  const results = [{ type: "function_call_output", call_id: "call_1", output: "result" }];

  assert.deepEqual(buildResponseContinuation(history, results, "resp_1", false), {
    input: history,
    previousResponseId: undefined,
  });
  assert.deepEqual(buildResponseContinuation(history, results, "resp_1", true), {
    input: results,
    previousResponseId: "resp_1",
  });
});

test("DeepSeek Responses usage reads cached tokens from input_tokens_details", () => {
  const usage = extractTokenUsage({
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: {
      cached_tokens: 40,
    },
  }, "deepseek-v4-flash");

  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cachedInputTokens, 40);
  assert.equal(usage.cost, 0);
  assert.ok((usage.costs?.CNY ?? 0) > 0);
});

test("DeepSeek V4 model limits and native CNY prices match the provider table", () => {
  assert.equal(getContextWindow("deepseek-v4-flash"), 1_000_000);
  assert.equal(getContextWindow("deepseek-v4-pro"), 1_000_000);
  assert.equal(getMaxOutputTokens("deepseek-v4-flash"), 384_000);
  assert.equal(getMaxOutputTokens("deepseek-v4-pro"), 384_000);
  assert.equal(getPricingCurrency("deepseek-v4-flash"), "CNY");
  assert.deepEqual(resolveModelInfo("deepseek-v4-flash").pricing, {
    input: 1,
    cachedInput: 0.02,
    output: 2,
  });
  assert.deepEqual(resolveModelInfo("deepseek-v4-pro").pricing, {
    input: 3,
    cachedInput: 0.025,
    output: 6,
  });
  assert.equal(calculateCost("deepseek-v4-flash", 1_000_000, 0, 0), 1);
  assert.equal(calculateCost("deepseek-v4-flash", 1_000_000, 0, 1_000_000), 0.02);
  assert.equal(calculateCost("deepseek-v4-flash", 0, 1_000_000, 0), 2);
});

test("usage accumulation keeps USD and CNY totals separate", () => {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
  };

  accumulateTokenUsage(total, {
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 0,
    cost: 0.5,
    costs: { USD: 0.5 },
  });
  accumulateTokenUsage(total, {
    inputTokens: 20,
    outputTokens: 3,
    cachedInputTokens: 5,
    cost: 0,
    costs: { CNY: 0.8 },
  });

  assert.deepEqual(total, {
    inputTokens: 30,
    outputTokens: 5,
    cachedInputTokens: 5,
    cost: 0.5,
    costs: {
      USD: 0.5,
      CNY: 0.8,
    },
  });
});

test("DeepSeek chat mode preserves reasoning content when thinking display is hidden", async () => {
  const client = {
    chat: {
      completions: {
        async create() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { reasoning_content: "private reasoning" } }] };
              yield { choices: [{ delta: { content: "answer" } }] };
            },
          };
        },
      },
    },
  };
  const bridge: UiBridge = {
    appendAssistantDelta() {},
    appendThinkingDelta() {
      assert.fail("hidden thinking must not be rendered");
    },
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool() {},
    updateUsage() {},
    noteStreamActivity() {},
    requestToolApproval: async () => "approved",
    requestUserChoice: async (questions) => questions.map((question) => [question.options[0]?.label ?? ""]),
  };

  const message = await streamChatCompletion(
    client as any,
    "deepseek-v4-pro",
    "system",
    [{ role: "user", content: "question" }],
    bridge,
    [],
    false,
  );

  assert.equal(message.content, "answer");
  assert.equal(message.reasoning_content, "private reasoning");
});

test("DeepSeek stateless agent loop replays tool context and prior user turns", async () => {
  await mcpManager.configure([]);
  await mcpManager.initializeAll();

  const requests: any[] = [];
  const responses = [
    {
      id: "resp_tool",
      output: [
        {
          type: "reasoning",
          id: "reasoning_1",
          content: [{ type: "reasoning_text", text: "I should call a tool." }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "missing_test_tool",
          arguments: "{}",
        },
      ],
    },
    {
      id: "resp_answer",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "first answer" }],
      }],
    },
    {
      id: "resp_follow_up",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "follow up answer" }],
      }],
    },
  ];
  const client = {
    responses: {
      stream(request: any) {
        requests.push(structuredClone(request));
        const response = responses[requests.length - 1];
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "response.created", response: { id: response.id } };
          },
          async finalResponse() {
            return response;
          },
        };
      },
    },
  };
  const state: AgentState = {
    sessionId: "deepseek-stateless",
    responseHistory: [],
    chatHistory: [],
    turnCount: 0,
    launchedAt: Date.now(),
    roundsSinceTask: 0,
    compactCount: 0,
  };
  const bridge: UiBridge = {
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
  const config = {
    client: client as any,
    model: "deepseek-v4-flash",
    baseURL: "https://api.deepseek.com",
    providerName: "deepseek",
    modelName: "deepseek-v4-flash",
    system: "You are helpful.",
    showThinking: true,
    apiMode: "responses" as const,
    supportsPreviousResponseId: false,
  };

  await runAgentTurn(config, "first question", [], state, bridge);
  await runAgentTurn(config, "follow up question", [], state, bridge);

  assert.equal(requests.length, 3);
  assert.ok(requests[0].tools.some((tool: any) => tool.type === "web_search"));
  assert.ok(!requests[0].tools.some((tool: any) => tool.type === "function" && tool.name === "web_search"));
  assert.equal(requests[0].previous_response_id, undefined);
  assert.equal(requests[1].previous_response_id, undefined);
  assert.deepEqual(
    requests[1].input.map((item: any) => item.type),
    ["message", "reasoning", "function_call", "function_call_output"],
  );
  assert.equal(requests[2].previous_response_id, undefined);
  assert.deepEqual(
    requests[2].input.map((item: any) => item.type),
    ["message", "reasoning", "function_call", "function_call_output", "message", "message"],
  );
  assert.equal(state.previousResponseId, undefined);
});
