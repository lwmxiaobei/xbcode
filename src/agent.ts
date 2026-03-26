import OpenAI from "openai";

import { TOOLS, CHAT_TOOLS, BASE_TOOLS, BASE_CHAT_TOOLS, TOOL_HANDLERS, taskManager } from "./tools.js";
import { microCompact, estimateTokens, autoCompact, TOKEN_THRESHOLD } from "./compact.js";
import type { ToolArgs, ResponseInputItem, ChatMessage, AgentState, UiBridge } from "./types.js";

const MAX_SUBAGENT_ROUNDS = 30;

function safeJsonParse(value: string): ToolArgs {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractAssistantText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && "text" in item) {
        return String((item as { text?: string }).text ?? "");
      }
      return "";
    })
    .join("");
}

async function streamResponse(
  client: OpenAI,
  model: string,
  system: string,
  showThinking: boolean,
  inputItems: ResponseInputItem[] | string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
  tools: readonly any[] = TOOLS,
): Promise<any> {
  const stream = client.responses.stream({
    model,
    instructions: system,
    input: inputItems as any,
    previous_response_id: previousResponseId,
    tools: tools as any,
  });

  for await (const event of stream as AsyncIterable<any>) {
    if (event.type === "response.output_text.delta") {
      bridge.appendAssistantDelta(String(event.delta ?? ""));
      continue;
    }

    if (showThinking && ["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type)) {
      bridge.appendThinkingDelta(String(event.delta ?? ""));
      continue;
    }

    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      bridge.finalizeStreaming();
    }
  }

  const response = await stream.finalResponse();
  bridge.finalizeStreaming();
  return response;
}

async function streamChatCompletion(
  client: OpenAI,
  model: string,
  system: string,
  history: ChatMessage[],
  bridge: UiBridge,
  tools: readonly any[] = CHAT_TOOLS,
  showThinking: boolean = false,
): Promise<{ content: string | null; tool_calls: any[]; reasoning_content?: string }> {
  const createParams: any = {
    model,
    messages: [{ role: "system", content: system }, ...history] as any,
    tools: tools as any,
    tool_choice: "auto",
    stream: true,
  };
  if (showThinking) {
    createParams.thinking = { type: "enabled" };
  }
  const stream = await client.chat.completions.create(createParams);

  let content = "";
  let reasoningContent = "";
  const toolCallBuffers: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta as any;
    if (!delta) continue;

    if (showThinking && delta.reasoning_content) {
      reasoningContent += delta.reasoning_content;
      bridge.appendThinkingDelta(delta.reasoning_content);
    }

    if (delta.content) {
      content += delta.content;
      bridge.appendAssistantDelta(delta.content);
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!toolCallBuffers[tc.index]) {
          toolCallBuffers[tc.index] = {
            id: tc.id ?? "",
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
        }
        const buf = toolCallBuffers[tc.index];
        if (tc.id) buf.id = tc.id;
        if (tc.function?.name) buf.function.name += tc.function.name;
        if (tc.function?.arguments) buf.function.arguments += tc.function.arguments;
      }
    }
  }

  bridge.finalizeStreaming();

  const toolCalls = Object.keys(toolCallBuffers)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => toolCallBuffers[Number(k)]);

  return {
    content: content || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : [],
    reasoning_content: reasoningContent || undefined,
  };
}

async function runToolCall(toolCall: any, bridge: UiBridge, handlers: Record<string, (args: ToolArgs) => Promise<string> | string>): Promise<ResponseInputItem> {
  const name = String(toolCall.name ?? toolCall.function?.name ?? "unknown_tool");
  const rawArgs = String(toolCall.arguments ?? toolCall.function?.arguments ?? "{}");
  const args = safeJsonParse(rawArgs);

  const handler = handlers[name];
  const outputText = handler ? await handler(args) : `Unknown tool: ${name}`;
  bridge.pushTool(name, args, outputText);

  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: outputText,
  };
}

const NAG_THRESHOLD = 3;
const NAG_MESSAGE = "<reminder>Update your tasks with task_list or task_update.</reminder>";

// ─── Sub-agent implementation ───────────────────────────────────────────

async function subAgentLoopResponses(
  client: OpenAI,
  model: string,
  system: string,
  description: string,
  bridge: UiBridge,
): Promise<string> {
  let nextInput: ResponseInputItem[] | string = [
    { role: "user", content: [{ type: "input_text", text: description }] },
  ];
  let currentResponseId: string | undefined;
  let lastText = "";

  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
    const response = await streamResponse(client, model, system, false, nextInput, currentResponseId, bridge, BASE_TOOLS);
    currentResponseId = response.id;

    // Collect any text output
    const textItems = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "message" || item.type === "text")
      : [];
    for (const item of textItems) {
      const text = extractAssistantText(item.content ?? item.text ?? "");
      if (text.trim()) lastText = text.trim();
    }

    // Also check for direct text in output
    const outputText = Array.isArray(response.output)
      ? response.output
          .map((item: any) => {
            if (item.type === "message") return extractAssistantText(item.content);
            return "";
          })
          .join("")
          .trim()
      : "";
    if (outputText) lastText = outputText;

    const toolCalls = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "function_call")
      : [];

    if (toolCalls.length === 0) break;

    const results: ResponseInputItem[] = [];
    for (const toolCall of toolCalls) {
      results.push(await runToolCall(toolCall, bridge, TOOL_HANDLERS));
    }
    nextInput = results;
  }

  return lastText || "(sub-agent completed with no text output)";
}

async function subAgentLoopChatCompletions(
  client: OpenAI,
  model: string,
  system: string,
  description: string,
  bridge: UiBridge,
): Promise<string> {
  const history: ChatMessage[] = [{ role: "user", content: description }];
  let lastText = "";

  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
    const message = await streamChatCompletion(client, model, system, history, bridge, BASE_CHAT_TOOLS, false);

    const assistantText = extractAssistantText(message.content);
    if (assistantText.trim()) {
      lastText = assistantText.trim();
    }

    history.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls.length > 0 ? message.tool_calls : undefined,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });

    const toolCalls = message.tool_calls;
    if (toolCalls.length === 0) break;

    for (const toolCall of toolCalls) {
      const name = String(toolCall.function?.name ?? "unknown_tool");
      const args = safeJsonParse(String(toolCall.function?.arguments ?? "{}"));
      const handler = TOOL_HANDLERS[name];
      const outputText = handler ? await handler(args) : `Unknown tool: ${name}`;
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });
    }
  }

  return lastText || "(sub-agent completed with no text output)";
}

// ─── Main agent loop ────────────────────────────────────────────────────

function buildToolHandlers(config: AgentConfig, state: AgentState, bridge: UiBridge): Record<string, (args: ToolArgs) => Promise<string> | string> {
  return {
    ...TOOL_HANDLERS,
    task: async ({ description }) => {
      const taskDescription = String(description);
      const subSystem = `${config.system}\nYou are a sub-agent handling a specific task. Complete it thoroughly and provide a clear summary of what you did.`;

      bridge.pushTool("task", { description: taskDescription }, "launching sub-agent...");

      let result: string;
      if (config.apiMode === "chat-completions") {
        result = await subAgentLoopChatCompletions(config.client, config.model, subSystem, taskDescription, bridge);
      } else {
        result = await subAgentLoopResponses(config.client, config.model, subSystem, taskDescription, bridge);
      }

      return result;
    },
  };
}

async function agentLoop(
  config: AgentConfig,
  query: string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
  state: AgentState,
  handlers: Record<string, (args: ToolArgs) => Promise<string> | string>,
): Promise<string | undefined> {
  let nextInput: ResponseInputItem[] | string = [
    {
      role: "user",
      content: [{ type: "input_text", text: query }],
    },
  ];
  let currentResponseId = previousResponseId;

  while (true) {
    const response = await streamResponse(config.client, config.model, config.system, config.showThinking, nextInput, currentResponseId, bridge);
    currentResponseId = response.id;

    const toolCalls = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "function_call")
      : [];

    if (toolCalls.length === 0) {
      return currentResponseId;
    }

    const hasTaskCall = toolCalls.some((tc: any) => String(tc.name).startsWith("task_"));
    state.roundsSinceTask = hasTaskCall ? 0 : state.roundsSinceTask + 1;

    const results: ResponseInputItem[] = [];
    for (const toolCall of toolCalls) {
      results.push(await runToolCall(toolCall, bridge, handlers));
    }

    if (state.roundsSinceTask >= NAG_THRESHOLD && taskManager.hasActiveTasks()) {
      const lastResult = results[results.length - 1] as any;
      if (lastResult) {
        lastResult.output = `${NAG_MESSAGE}\n${lastResult.output}`;
      }
    }

    nextInput = results;
  }
}

async function agentLoopWithChatCompletions(
  config: AgentConfig,
  history: ChatMessage[],
  bridge: UiBridge,
  state: AgentState,
  handlers: Record<string, (args: ToolArgs) => Promise<string> | string>,
): Promise<void> {
  while (true) {
    // Layer 1: micro-compact old tool results each round
    microCompact(history);

    // Layer 2: auto-compact when token estimate exceeds threshold
    if (estimateTokens(history) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      const compacted = await autoCompact(config.client, config.model, history);
      history.length = 0;
      history.push(...compacted);
      state.compactCount += 1;
    }

    const message = await streamChatCompletion(config.client, config.model, config.system, history, bridge, CHAT_TOOLS, config.showThinking);

    history.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls.length > 0 ? message.tool_calls : undefined,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });

    const toolCalls = message.tool_calls;
    if (toolCalls.length === 0) {
      return;
    }

    const hasTaskCall = toolCalls.some((tc: any) => String(tc.function?.name).startsWith("task_"));
    state.roundsSinceTask = hasTaskCall ? 0 : state.roundsSinceTask + 1;

    for (const toolCall of toolCalls) {
      const name = String(toolCall.function?.name ?? "unknown_tool");
      const args = safeJsonParse(String(toolCall.function?.arguments ?? "{}"));
      const handler = handlers[name];
      const outputText = handler ? await handler(args) : `Unknown tool: ${name}`;
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });
    }

    if (state.roundsSinceTask >= NAG_THRESHOLD && taskManager.hasActiveTasks()) {
      history.push({
        role: "user",
        content: NAG_MESSAGE,
      });
    }
  }
}

export type AgentConfig = {
  client: OpenAI;
  model: string;
  system: string;
  showThinking: boolean;
  apiMode: "responses" | "chat-completions";
};

const RESPONSES_COMPACT_INTERVAL = 20;

export async function runAgentTurn(config: AgentConfig, query: string, state: AgentState, bridge: UiBridge): Promise<void> {
  const { apiMode } = config;
  state.turnCount += 1;
  state.roundsSinceTask = 0;

  const handlers = buildToolHandlers(config, state, bridge);

  if (apiMode === "chat-completions") {
    // Clear reasoning_content from previous turns to save bandwidth (DeepSeek doc requirement)
    for (const msg of state.chatHistory) {
      if (msg.role === "assistant" && "reasoning_content" in msg) {
        delete msg.reasoning_content;
      }
    }

    // Micro-compact before adding new user message
    microCompact(state.chatHistory);

    // Auto-compact if over threshold
    if (estimateTokens(state.chatHistory) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      const compacted = await autoCompact(config.client, config.model, state.chatHistory);
      state.chatHistory.length = 0;
      state.chatHistory.push(...compacted);
      state.compactCount += 1;
    }

    state.chatHistory.push({ role: "user", content: query });
    await agentLoopWithChatCompletions(config, state.chatHistory, bridge, state, handlers);
    return;
  }

  // Responses API: compact by resetting chain every N turns
  if (state.turnCount > 1 && (state.turnCount - 1) % RESPONSES_COMPACT_INTERVAL === 0) {
    bridge.pushAssistant("Compacting Responses API context chain...");
    state.previousResponseId = undefined;
    state.compactCount += 1;
  }

  state.previousResponseId = await agentLoop(config, query, state.previousResponseId, bridge, state, handlers);
}
