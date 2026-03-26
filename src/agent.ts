import OpenAI, { APIUserAbortError } from "openai";

import { microCompact, estimateTokens, autoCompact, TOKEN_THRESHOLD } from "./compact.js";
import { messageBus, teammateManager, LEAD_NAME, TOOLS, CHAT_TOOLS, BASE_TOOLS, BASE_CHAT_TOOLS, TEAMMATE_TOOLS, TEAMMATE_CHAT_TOOLS, BASE_TOOL_HANDLERS, taskManager } from "./tools.js";
import { renderInboxPrompt } from "./message-bus.js";
import type { TeammateRuntimeControl } from "./teammate-manager.js";
import type { ToolArgs, ResponseInputItem, ChatMessage, AgentState, UiBridge } from "./types.js";

const MAX_SUBAGENT_ROUNDS = 30;
const NAG_THRESHOLD = 3;
const NAG_MESSAGE = "<reminder>Update your tasks with task_list or task_update.</reminder>";
const RESPONSES_COMPACT_INTERVAL = 20;

type ToolHandler = (args: ToolArgs, control?: RunControl) => Promise<string> | string;
type ToolHandlerMap = Record<string, ToolHandler>;
type RunControl = {
  signal?: AbortSignal;
};

export class TurnInterruptedError extends Error {
  responseId?: string;
  partialAssistantText?: string;

  constructor(options?: { responseId?: string; partialAssistantText?: string }) {
    super("Turn interrupted by user.");
    this.name = "TurnInterruptedError";
    this.responseId = options?.responseId;
    this.partialAssistantText = options?.partialAssistantText;
  }
}

export function isTurnInterruptedError(error: unknown): error is TurnInterruptedError {
  return error instanceof TurnInterruptedError;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TurnInterruptedError();
  }
}

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

function repairInterruptedToolCallHistory(history: ChatMessage[]): void {
  if (history.length === 0) {
    return;
  }

  let assistantIndex = history.length - 1;
  while (assistantIndex >= 0 && history[assistantIndex]?.role === "tool") {
    assistantIndex -= 1;
  }

  if (assistantIndex < 0) {
    return;
  }

  const assistantMessage = history[assistantIndex];
  if (assistantMessage?.role !== "assistant" || !Array.isArray(assistantMessage.tool_calls) || assistantMessage.tool_calls.length === 0) {
    return;
  }

  const trailingMessages = history.slice(assistantIndex + 1);
  if (!trailingMessages.every((message) => message.role === "tool")) {
    return;
  }

  const expectedToolCallIds = assistantMessage.tool_calls
    .map((toolCall: any) => String(toolCall?.id ?? ""))
    .filter(Boolean);
  if (expectedToolCallIds.length === 0) {
    return;
  }

  const actualToolCallIds = new Set(
    trailingMessages.map((message) => String(message.tool_call_id ?? "")).filter(Boolean),
  );
  const hasAllToolResponses = expectedToolCallIds.every((toolCallId) => actualToolCallIds.has(toolCallId));
  if (hasAllToolResponses) {
    return;
  }

  const assistantText = String(assistantMessage.content ?? "");
  history.splice(assistantIndex);
  if (assistantText.trim()) {
    history.push({
      role: "assistant",
      content: assistantText,
    });
  }
}

function createSilentBridge(): UiBridge {
  return {
    appendAssistantDelta() {},
    appendThinkingDelta() {},
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool() {},
  };
}

function normalizeTeammateName(value: unknown): string {
  return String(value ?? "").trim();
}

function isValidTeammateName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeMessageType(value: unknown): "message" | "broadcast" {
  return value === "broadcast" ? "broadcast" : "message";
}

function buildTeammateSystem(baseSystem: string, name: string, role: string): string {
  return `${baseSystem}
You are teammate "${name}" in a persistent agent team.
Your role: ${role}.
You do not speak directly to the human user.
You receive work through inbox messages injected as user messages.
Use message_send to coordinate with lead or other teammates.
When you complete a meaningful chunk, send a concise update to lead.`;
}

function buildInboxWorkPrompt(): string {
  return "Process the inbox items in order. Use available tools to do the work. Coordinate via message_send when needed.";
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
  control?: RunControl,
): Promise<any> {
  throwIfAborted(control?.signal);

  const stream = client.responses.stream({
    model,
    instructions: system,
    input: inputItems as any,
    previous_response_id: previousResponseId,
    tools: tools as any,
  }, control?.signal ? { signal: control.signal } : undefined);

  let responseId: string | undefined;
  let assistantText = "";

  try {
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type === "response.created") {
        responseId = String(event.response?.id ?? responseId ?? "");
      }

      if (event.type === "response.output_text.delta") {
        const delta = String(event.delta ?? "");
        assistantText += delta;
        bridge.appendAssistantDelta(delta);
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
  } catch (error) {
    bridge.finalizeStreaming();
    if (error instanceof APIUserAbortError || control?.signal?.aborted) {
      throw new TurnInterruptedError({
        responseId,
        partialAssistantText: assistantText || undefined,
      });
    }
    throw error;
  }
}

async function streamChatCompletion(
  client: OpenAI,
  model: string,
  system: string,
  history: ChatMessage[],
  bridge: UiBridge,
  tools: readonly any[] = CHAT_TOOLS,
  showThinking: boolean = false,
  control?: RunControl,
): Promise<{ content: string | null; tool_calls: any[]; reasoning_content?: string }> {
  throwIfAborted(control?.signal);

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
  const stream = await client.chat.completions.create(
    createParams as any,
    control?.signal ? { signal: control.signal } : undefined,
  ) as any;

  let content = "";
  let reasoningContent = "";
  const toolCallBuffers: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};

  try {
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
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => toolCallBuffers[Number(key)]);

    return {
      content: content || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : [],
      reasoning_content: reasoningContent || undefined,
    };
  } catch (error) {
    bridge.finalizeStreaming();
    if (error instanceof APIUserAbortError || control?.signal?.aborted) {
      throw new TurnInterruptedError({
        partialAssistantText: content || undefined,
      });
    }
    throw error;
  }
}

async function runToolCall(
  toolCall: any,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  control?: RunControl,
): Promise<ResponseInputItem> {
  const name = String(toolCall.name ?? toolCall.function?.name ?? "unknown_tool");
  const rawArgs = String(toolCall.arguments ?? toolCall.function?.arguments ?? "{}");
  const args = safeJsonParse(rawArgs);

  const handler = handlers[name];
  const outputText = handler ? await handler(args, control) : `Unknown tool: ${name}`;
  bridge.pushTool(name, args, outputText);

  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: outputText,
  };
}

async function sendTeamMessage(from: string, to: string, content: string, type: "message" | "broadcast"): Promise<string> {
  const recipient = to.trim();
  const body = content.trim();
  if (!recipient) {
    return "Error: Missing recipient.";
  }
  if (!body) {
    return "Error: Missing content.";
  }

  let recipients: string[];
  if (type === "broadcast" && recipient === "all") {
    recipients = [LEAD_NAME, ...teammateManager.listMembers().map((member) => member.name)]
      .filter((name, index, all) => name !== from && all.indexOf(name) === index);
  } else {
    recipients = [recipient];
  }

  if (recipients.length === 0) {
    return "Error: No recipients available.";
  }

  for (const name of recipients) {
    if (name === LEAD_NAME) {
      continue;
    }

    const member = teammateManager.getMember(name);
    if (!member) {
      return `Error: Unknown teammate: ${name}`;
    }
    if (!teammateManager.isRunning(name)) {
      return `Error: Teammate ${name} is not running. Spawn or restart it first.`;
    }
  }

  for (const name of recipients) {
    messageBus.send({
      from,
      to: name,
      content: body,
      type: type === "broadcast" ? "broadcast" : "message",
    });
    if (name !== LEAD_NAME) {
      teammateManager.wake(name);
    }
  }

  return `Sent ${type} to ${recipients.join(", ")}`;
}

function buildSharedTeamHandlers(agentName: string): Pick<ToolHandlerMap, "message_send"> {
  return {
    message_send: async ({ to, content, type }) => sendTeamMessage(
      agentName,
      String(to ?? ""),
      String(content ?? ""),
      normalizeMessageType(type),
    ),
  };
}

async function launchTeammateRuntime(config: AgentConfig, control: TeammateRuntimeControl): Promise<void> {
  const bridge = createSilentBridge();
  const handlers = buildTeammateHandlers(control.name);

  while (true) {
    if (!teammateManager.shouldStop(control) && messageBus.inboxSize(control.name) === 0) {
      teammateManager.markIdle(control.name);
      await teammateManager.waitForWake(control);
    }

    const inbox = messageBus.drainInbox(control.name);
    const shutdownRequested = inbox.some((message) => message.type === "shutdown_request");
    const actionableMessages = inbox.filter((message) => message.type !== "shutdown_request");

    if (actionableMessages.length > 0) {
      teammateManager.markWorking(control.name);
      const prompt = `${renderInboxPrompt(actionableMessages)}\n\n${buildInboxWorkPrompt()}`;
      await runTurn(
        config,
        prompt,
        control.state,
        bridge,
        handlers,
        TEAMMATE_TOOLS,
        TEAMMATE_CHAT_TOOLS,
      );
    }

    if (shutdownRequested || teammateManager.shouldStop(control)) {
      messageBus.send({
        from: control.name,
        to: LEAD_NAME,
        type: "shutdown_response",
        content: `Teammate ${control.name} has shut down.`,
      });
      teammateManager.markStopped(control.name);
      return;
    }
  }
}

function buildLeadHandlers(config: AgentConfig, bridge: UiBridge): ToolHandlerMap {
  return {
    ...BASE_TOOL_HANDLERS,
    ...buildSharedTeamHandlers(LEAD_NAME),
    task: async ({ description }) => {
      const taskDescription = String(description ?? "");
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
    teammate_spawn: async ({ name, role, prompt }) => {
      const teammateName = normalizeTeammateName(name);
      const teammateRole = String(role ?? "").trim();
      const initialPrompt = String(prompt ?? "").trim();

      if (!teammateName || !teammateRole || !initialPrompt) {
        return "Error: name, role, and prompt are required.";
      }
      if (!isValidTeammateName(teammateName)) {
        return `Error: Invalid teammate name: ${teammateName}`;
      }
      if (teammateName === LEAD_NAME) {
        return `Error: ${LEAD_NAME} is reserved.`;
      }
      if (teammateManager.isRunning(teammateName)) {
        return `Error: Teammate ${teammateName} is already running. Use message_send to assign more work.`;
      }

      teammateManager.ensureMember(teammateName, teammateRole);

      const { started } = teammateManager.startRuntime(teammateName, teammateRole, async (control) => {
        const teammateConfig: AgentConfig = {
          ...config,
          system: buildTeammateSystem(config.system, teammateName, teammateRole),
        };
        await launchTeammateRuntime(teammateConfig, control);
      });

      if (!started) {
        return `Error: Teammate ${teammateName} is already running.`;
      }

      messageBus.send({
        from: LEAD_NAME,
        to: teammateName,
        type: "message",
        content: initialPrompt,
      });
      teammateManager.wake(teammateName);

      return `Spawned teammate ${teammateName} (${teammateRole}). Initial prompt delivered.`;
    },
    teammate_shutdown: ({ name }) => {
      const requestedName = String(name ?? "").trim();
      const targets = requestedName
        ? [requestedName]
        : teammateManager.listMembers().map((member) => member.name);

      if (targets.length === 0) {
        return "(no teammates)";
      }

      return targets
        .map((teammateName) => {
          const member = teammateManager.getMember(teammateName);
          if (!member) {
            return `- ${teammateName}: not found`;
          }

          if (!teammateManager.isRunning(teammateName)) {
            teammateManager.markStopped(teammateName);
            return `- ${teammateName}: already stopped`;
          }

          messageBus.send({
            from: LEAD_NAME,
            to: teammateName,
            type: "shutdown_request",
            content: "Graceful shutdown requested by lead.",
          });
          teammateManager.requestStop(teammateName);
          teammateManager.wake(teammateName);
          return `- ${teammateName}: shutdown requested`;
        })
        .join("\n");
    },
  };
}

function buildTeammateHandlers(agentName: string): ToolHandlerMap {
  return {
    ...BASE_TOOL_HANDLERS,
    ...buildSharedTeamHandlers(agentName),
  };
}

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

  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round += 1) {
    const response = await streamResponse(client, model, system, false, nextInput, currentResponseId, bridge, BASE_TOOLS);
    currentResponseId = response.id;

    const textItems = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "message" || item.type === "text")
      : [];
    for (const item of textItems) {
      const text = extractAssistantText(item.content ?? item.text ?? "");
      if (text.trim()) lastText = text.trim();
    }

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
      results.push(await runToolCall(toolCall, bridge, BASE_TOOL_HANDLERS));
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

  for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round += 1) {
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
      const handler = BASE_TOOL_HANDLERS[name];
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

async function agentLoop(
  config: AgentConfig,
  query: string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
  state: AgentState,
  handlers: ToolHandlerMap,
  tools: readonly any[] = TOOLS,
  control?: RunControl,
): Promise<string | undefined> {
  let nextInput: ResponseInputItem[] | string = [
    {
      role: "user",
      content: [{ type: "input_text", text: query }],
    },
  ];
  let currentResponseId = previousResponseId;

  while (true) {
    throwIfAborted(control?.signal);

    const response = await streamResponse(
      config.client,
      config.model,
      config.system,
      config.showThinking,
      nextInput,
      currentResponseId,
      bridge,
      tools,
      control,
    );
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
      throwIfAborted(control?.signal);
      results.push(await runToolCall(toolCall, bridge, handlers, control));
      throwIfAborted(control?.signal);
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
  handlers: ToolHandlerMap,
  tools: readonly any[] = CHAT_TOOLS,
  control?: RunControl,
): Promise<void> {
  while (true) {
    throwIfAborted(control?.signal);
    microCompact(history);

    if (estimateTokens(history) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      const compacted = await autoCompact(config.client, config.model, history);
      history.length = 0;
      history.push(...compacted);
      state.compactCount += 1;
    }

    let message;
    try {
      message = await streamChatCompletion(
        config.client,
        config.model,
        config.system,
        history,
        bridge,
        tools,
        config.showThinking,
        control,
      );
    } catch (error) {
      if (error instanceof TurnInterruptedError && error.partialAssistantText) {
        history.push({
          role: "assistant",
          content: error.partialAssistantText,
        });
      }
      throw error;
    }

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
      throwIfAborted(control?.signal);
      const name = String(toolCall.function?.name ?? "unknown_tool");
      const args = safeJsonParse(String(toolCall.function?.arguments ?? "{}"));
      const handler = handlers[name];
      const outputText = handler ? await handler(args, control) : `Unknown tool: ${name}`;
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });

      throwIfAborted(control?.signal);
    }

    if (state.roundsSinceTask >= NAG_THRESHOLD && taskManager.hasActiveTasks()) {
      history.push({
        role: "user",
        content: NAG_MESSAGE,
      });
    }
  }
}

async function runTurn(
  config: AgentConfig,
  query: string,
  state: AgentState,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  responseTools: readonly any[],
  chatTools: readonly any[],
  control?: RunControl,
): Promise<void> {
  throwIfAborted(control?.signal);
  const { apiMode } = config;
  state.turnCount += 1;
  state.roundsSinceTask = 0;

  if (apiMode === "chat-completions") {
    for (const msg of state.chatHistory) {
      if (msg.role === "assistant" && "reasoning_content" in msg) {
        delete msg.reasoning_content;
      }
    }

    microCompact(state.chatHistory);

    if (estimateTokens(state.chatHistory) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      const compacted = await autoCompact(config.client, config.model, state.chatHistory);
      state.chatHistory.length = 0;
      state.chatHistory.push(...compacted);
      state.compactCount += 1;
    }

    state.chatHistory.push({ role: "user", content: query });
    try {
      await agentLoopWithChatCompletions(config, state.chatHistory, bridge, state, handlers, chatTools, control);
    } catch (error) {
      if (error instanceof TurnInterruptedError) {
        repairInterruptedToolCallHistory(state.chatHistory);
      }
      throw error;
    }
    return;
  }

  if (state.turnCount > 1 && (state.turnCount - 1) % RESPONSES_COMPACT_INTERVAL === 0) {
    bridge.pushAssistant("Compacting Responses API context chain...");
    state.previousResponseId = undefined;
    state.compactCount += 1;
  }

  try {
    state.previousResponseId = await agentLoop(config, query, state.previousResponseId, bridge, state, handlers, responseTools, control);
  } catch (error) {
    if (error instanceof TurnInterruptedError && error.responseId) {
      state.previousResponseId = error.responseId;
    }
    throw error;
  }
}

export type AgentConfig = {
  client: OpenAI;
  model: string;
  system: string;
  showThinking: boolean;
  apiMode: "responses" | "chat-completions";
};

export async function runAgentTurn(
  config: AgentConfig,
  query: string,
  state: AgentState,
  bridge: UiBridge,
  control?: RunControl,
): Promise<void> {
  const handlers = buildLeadHandlers(config, bridge);
  await runTurn(config, query, state, bridge, handlers, TOOLS, CHAT_TOOLS, control);
}
