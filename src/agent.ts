import OpenAI from "openai";

import {
  microCompact,
  estimateTokens,
  autoCompact,
  autoCompactResponseHistory,
  TOKEN_THRESHOLD,
} from "./compact.js";
import { logApiError } from "./error-log.js";
import { getDynamicMcpToolSurface } from "./mcp/runtime.js";
import { messageBus, teammateManager, LEAD_NAME, TOOLS, CHAT_TOOLS, BASE_TOOLS, BASE_CHAT_TOOLS, TEAMMATE_TOOLS, TEAMMATE_CHAT_TOOLS, BASE_TOOL_HANDLERS, taskManager } from "./tools.js";
import { formatTeammateMessages } from "./message-bus.js";
import { createGoal, getGoal, updateGoalFromModel } from "./goal-manager.js";
import { getSubagentDefinition } from "./subagents.js";
import { dispatchSubagent } from "./subagent-runner.js";
import type { TeammateRuntimeControl } from "./teammate-manager.js";
import type { ResponseInputItem, ChatMessage, AgentState, UiBridge, TokenUsage, ImageAttachment, ToolApprovalDecision, UserChoiceQuestion } from "./types.js";
import { ResponseStreamError, TurnInterruptedError, throwIfAborted } from "./agent/interrupt.js";
import { buildAssistantResponseMessage, buildChatUserMessageContent, buildCompactedResponsesQuery, buildInterruptedResponsesContext, buildUserResponseMessage, cloneResponseReplayItem, collectReplayableResponseOutput, extractAssistantText, repairInterruptedToolCallHistory, shouldPreserveChatReasoningContent } from "./agent/messages.js";
import type { PreparedToolRuntime, RunControl, ToolHandlerMap } from "./agent/runtime-types.js";
import { buildToolRejectionOutput, toolNeedsApproval } from "./agent/tool-approval.js";
import { safeJsonParse } from "./agent/tool-args.js";
import { runToolCall } from "./agent/tool-call.js";
import { streamChatCompletion, streamResponse } from "./agent/streams.js";
import { ASK_USER_QUESTION_TOOL_NAME, runAskUserQuestion } from "./agent/user-choice.js";
export { TurnInterruptedError, isTurnInterruptedError } from "./agent/interrupt.js";
export { ASK_USER_QUESTION_TOOL_NAME, parseUserChoiceQuestions, formatUserChoiceResult } from "./agent/user-choice.js";
export { extractAssistantTextFromResponseOutput, getMissingAssistantText, shouldPreserveChatReasoningContent } from "./agent/messages.js";

// P1：删除 MailboxEventType / MAILBOX_EVENT_TYPES / normalizeEventType。
// 这些是 P3 协议消息字段，从 P1 阶段的 MailboxMessage 中已彻底移除。


const NAG_THRESHOLD = 3;

const NAG_MESSAGE = "<reminder>Update your tasks with task_list or task_update.</reminder>";

const RESPONSES_COMPACT_INTERVAL = 20;

function createSilentBridge(): UiBridge {
  return {
    appendAssistantDelta() {},
    appendThinkingDelta() {},
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool() {},
    updateUsage() {},
    noteStreamActivity() {},
    // Sub-agents and teammates run autonomously: auto-approve their tool calls.
    requestToolApproval() {
      return Promise.resolve<ToolApprovalDecision>("approved");
    },
    // 自治 agent 无人可问：对每道题返回首选项作为确定性默认答案。
    requestUserChoice(questions: UserChoiceQuestion[]) {
      return Promise.resolve(
        questions.map((question) => (question.options[0] ? [question.options[0].label] : [])),
      );
    },
  };
}

function normalizeTeammateName(value: unknown): string {
  return String(value ?? "").trim();
}

function isValidTeammateName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

// P1：删除 normalizeMessageType。message_send 不再支持 broadcast type；
// P3 协议消息阶段会用独立工具（不混在 message_send schema 里）。

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

async function prepareToolRuntime(
  baseHandlers: ToolHandlerMap,
  baseResponseTools: readonly any[],
  baseChatTools: readonly any[],
): Promise<PreparedToolRuntime> {
  const dynamicMcp = await getDynamicMcpToolSurface();
  return {
    handlers: {
      ...baseHandlers,
      ...dynamicMcp.handlers,
    },
    responseTools: [
      ...baseResponseTools,
      ...dynamicMcp.responseTools,
    ],
    chatTools: [
      ...baseChatTools,
      ...dynamicMcp.chatTools,
    ],
  };
}

async function sendTeamMessage(
  from: string,
  to: string,
  content: string,
): Promise<string> {
  const recipient = to.trim();
  const body = content.trim();
  if (!recipient) {
    return "Error: Missing recipient.";
  }
  if (!body) {
    return "Error: Missing content.";
  }

  // 校验收件人：lead 总是合法；teammate 必须存在且在运行。
  if (recipient !== LEAD_NAME) {
    const member = teammateManager.getMember(recipient);
    if (!member) {
      return `Error: Unknown teammate: ${recipient}`;
    }
    if (!teammateManager.isRunning(recipient)) {
      return `Error: Teammate ${recipient} is not running. Spawn or restart it first.`;
    }
  }

  await messageBus.send({ from, to: recipient, content: body });

  // 给 teammate 发消息时主动 wake 一下，让 idle 队友立刻处理；
  // 给 lead 的消息由 MessageBus.onSend("lead") 在 UI 层触发自动续轮，此处不耦合。
  if (recipient !== LEAD_NAME) {
    teammateManager.wake(recipient);
  }

  return `Sent message to ${recipient}`;
}

function buildSharedTeamHandlers(agentName: string): Pick<ToolHandlerMap, "message_send"> {
  return {
    // P1：消息工具只支持 to + content。扩展字段（type/eventType/taskId 等）随 P3 协议消息重做。
    message_send: async ({ to, content }) =>
      sendTeamMessage(agentName, String(to ?? ""), String(content ?? "")),
  };
}

async function launchTeammateRuntime(config: AgentConfig, control: TeammateRuntimeControl): Promise<void> {
  const bridge = createSilentBridge();

  while (true) {
    // 没未读消息则进 idle，等待 wake（teammateManager.wake 由 sendTeamMessage 主动调用）。
    if (!teammateManager.shouldStop(control) && (await messageBus.unreadCount(control.name)) === 0) {
      teammateManager.markIdle(control.name);
      await teammateManager.waitForWake(control);
    }

    // P1：用 readUnread + markRead 替代 drainInbox。文件保留全部历史，
    // 重启后未处理的 unread 消息仍然可见，便于审计与可恢复性。
    // shutdown_request 协议消息从 P1 阶段的 MailboxMessage 中已移除，本轮不再过滤；
    // P3 阶段重做协议时会用独立机制（不再混在 mailbox）。
    const inbox = await messageBus.readUnread(control.name);
    if (inbox.length > 0) {
      await messageBus.markRead(control.name, inbox);
    }
    // P1：保持 shutdown 路径在外层（teammateManager.requestStop / shouldStop），
    // 此处不再检测「邮件中是否含 shutdown_request」。
    const shutdownRequested = false;
    const actionableMessages = inbox;

    if (actionableMessages.length > 0) {
      teammateManager.markWorking(control.name);
      const prompt = `${formatTeammateMessages(actionableMessages)}\n\n${buildInboxWorkPrompt()}`;
      const attachments: ImageAttachment[] = [];
      const runtime = await prepareToolRuntime(
        buildTeammateHandlers(control.name),
        TEAMMATE_TOOLS,
        TEAMMATE_CHAT_TOOLS,
      );
      await runTurn(
        config,
        prompt,
        attachments,
        control.state,
        bridge,
        runtime.handlers,
        runtime.responseTools,
        runtime.chatTools,
        undefined,
        `teammate:${control.name}`,
      );
    }

    if (shutdownRequested || teammateManager.shouldStop(control)) {
      // P1：删除 shutdown_response 协议邮件。lead 通过 teammate_list 看 status=stopped
      // 即可感知；P3 协议消息阶段会用独立 schema 重做这个回执。
      // 仍然给 lead 发一条人类可读的简短通知，便于 UI 显示队友已退出。
      await messageBus.send({
        from: control.name,
        to: LEAD_NAME,
        content: `Teammate ${control.name} has shut down.`,
      });
      teammateManager.markStopped(control.name);
      return;
    }
  }
}

function buildLeadHandlers(config: AgentConfig, bridge: UiBridge, state: AgentState): ToolHandlerMap {
  return {
    ...BASE_TOOL_HANDLERS,
    ...buildSharedTeamHandlers(LEAD_NAME),
    get_goal: () => getGoal(state),
    create_goal: ({ objective, token_budget }) => createGoal(
      state,
      String(objective ?? ""),
      typeof token_budget === "number" ? token_budget : undefined,
    ),
    update_goal: ({ status }) => updateGoalFromModel(state, status),
    subagent: async ({ description, subagent_type }) => {
      const taskDescription = String(description ?? "");
      const definition = getSubagentDefinition(typeof subagent_type === "string" ? subagent_type : undefined);

      bridge.pushTool(
        "subagent",
        { description: taskDescription, subagent_type: definition.name },
        `launching ${definition.name} sub-agent (isolated process)...`,
      );

      // 子代理跑在独立 OS 进程里（完全隔离、不触碰 session-store），通过 stdin
      // 传规格、stdout 用 JSONL 回传工具调用与最终结果。
      return await dispatchSubagent(
        {
          subagentType: definition.name,
          description: taskDescription,
          system: config.system,
          providerName: config.providerName,
          modelName: config.modelName,
        },
        bridge,
      );
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

      // P1：teammate_spawn 后向新队友邮箱投递初始 prompt。
      // 简化为 from/to/content；新 send API 是 async，必须 await。
      await messageBus.send({
        from: LEAD_NAME,
        to: teammateName,
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

          // P1：删除 shutdown_request 协议邮件。优雅退出由 teammateManager.requestStop
          // 在控制平面（control.stopRequested）实现，不再依赖邮箱传协议字段。
          // 同时给目标队友发一条人类可读的退出通知，让队友 loop 在处理完最后一条邮件后
          // 通过 shouldStop 检测到主动退出意图（注：本通知是普通消息，不是协议）。
          void messageBus.send({
            from: LEAD_NAME,
            to: teammateName,
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

async function agentLoop(
  config: AgentConfig,
  query: string,
  attachments: ImageAttachment[],
  previousResponseId: string | undefined,
  bridge: UiBridge,
  state: AgentState,
  handlers: ToolHandlerMap,
  tools: readonly any[] = TOOLS,
  control?: RunControl,
  onUsage?: (usage: TokenUsage) => void,
  caller: string = "main",
): Promise<string | undefined> {
  /**
   * Most Responses providers support `previous_response_id`, so they can keep
   * server-side state and only receive the latest delta. ChatGPT Codex OAuth
   * does not support that parameter, so in that one branch we replay the local
   * conversation transcript on every round instead.
   */
  const usesStatelessReplay = !config.supportsPreviousResponseId;
  /**
   * 无论 provider 是否支持 `previous_response_id`，本地都持续维护一份可重放历史。
   *
   * 为什么要在 stateful provider 上也这么做：
   * - responses 模式的 compact 需要本地历史做总结，否则只能定期把链路清空。
   * - `/resume`、状态栏估算、手动 `/compact` 也都依赖同一份本地上下文副本。
   * - 真正请求模型时，只有 stateless 分支会重放它，因此不会改变支持服务端链路的正常交互成本。
   */
  const baseReplayHistoryLength = state.responseHistory.length;
  const replayHistory = [
    ...state.responseHistory.map((item) => cloneResponseReplayItem(item)),
    buildUserResponseMessage(query, attachments),
  ];
  let nextInput: ResponseInputItem[] | string = usesStatelessReplay
    ? replayHistory
    : [buildUserResponseMessage(query, attachments)];
  let currentResponseId = usesStatelessReplay ? undefined : previousResponseId;

  while (true) {
    throwIfAborted(control?.signal);

    let response;
    try {
      response = await streamResponse(
        config.client,
        config.model,
        config.system,
        config.showThinking,
        nextInput,
        currentResponseId,
        bridge,
        tools,
        control,
        onUsage,
        caller,
      );
    } catch (error) {
      if (error instanceof ResponseStreamError) {
        const interruptedHistory = replayHistory.map((item) => cloneResponseReplayItem(item));
        if (error.partialAssistantText) {
          interruptedHistory.push(buildAssistantResponseMessage(error.partialAssistantText));
        }
        state.responseHistory = interruptedHistory;
        if (!usesStatelessReplay) {
          state.pendingCompactedContext = buildInterruptedResponsesContext(interruptedHistory.slice(baseReplayHistoryLength));
        }
      }
      throw error;
    }
    currentResponseId = response.id;

    replayHistory.push(...collectReplayableResponseOutput(response.output));

    const toolCalls = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "function_call")
      : [];

    if (toolCalls.length === 0) {
      state.responseHistory = replayHistory.map((item) => cloneResponseReplayItem(item));
      return currentResponseId;
    }

    const hasTaskCall = toolCalls.some((tc: any) => String(tc.name).startsWith("task_"));
    state.roundsSinceTask = hasTaskCall ? 0 : state.roundsSinceTask + 1;

    const results: ResponseInputItem[] = [];
    for (const toolCall of toolCalls) {
      throwIfAborted(control?.signal);
      results.push(await runToolCall(toolCall, bridge, handlers, control, true));
      throwIfAborted(control?.signal);
    }

    if (state.roundsSinceTask >= NAG_THRESHOLD && await taskManager.hasActiveTasks()) {
      const lastResult = results[results.length - 1] as any;
      if (lastResult) {
        lastResult.output = `${NAG_MESSAGE}\n${lastResult.output}`;
      }
    }

    replayHistory.push(...results.map((item) => cloneResponseReplayItem(item)));

    if (usesStatelessReplay) {
      nextInput = replayHistory;
      currentResponseId = undefined;
    } else {
      nextInput = results;
    }
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
  onUsage?: (usage: TokenUsage) => void,
  caller: string = "main",
): Promise<void> {
  while (true) {
    throwIfAborted(control?.signal);
    microCompact(history);

    if (estimateTokens(history) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      try {
        const compacted = await autoCompact(config.client, config.model, history);
        history.length = 0;
        history.push(...compacted.messages);
        state.compactCount += 1;
      } catch (error) {
        logApiError(caller, error, {
          api: "autoCompact",
          model: config.model,
          historyLength: history.length,
        });
        bridge.pushAssistant("⚠️ Compaction failed due to API error. Proceeding with raw history.");
      }
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
        onUsage,
        caller,
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

      let outputText: string;
      if (name === ASK_USER_QUESTION_TOOL_NAME) {
        outputText = await runAskUserQuestion(args, bridge);
      } else if (toolNeedsApproval(name) && (await bridge.requestToolApproval(name, args)) === "rejected") {
        outputText = buildToolRejectionOutput(name);
      } else {
        const handler = handlers[name];
        outputText = handler ? await handler(args, control) : `Unknown tool: ${name}`;
      }
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });

      throwIfAborted(control?.signal);
    }

    if (state.roundsSinceTask >= NAG_THRESHOLD && await taskManager.hasActiveTasks()) {
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
  attachments: ImageAttachment[],
  state: AgentState,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  responseTools: readonly any[],
  chatTools: readonly any[],
  control?: RunControl,
  caller: string = "main",
): Promise<TurnResult> {
  throwIfAborted(control?.signal);
  const startedAt = Date.now();
  const { apiMode } = config;
  state.turnCount += 1;
  state.roundsSinceTask = 0;

  // 单轮用量：用于 goal 预算结算等"按轮"的统计，随每轮新建归零。
  const turnUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 };
  // 会话累计用量：跨所有轮次累加，状态栏据此显示整段会话烧了多少。
  // 兜底：恢复的旧 session 快照可能没有此字段。
  const cumulativeUsage: TokenUsage = (state.cumulativeUsage ??= {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
  });
  const onUsage = (u: TokenUsage) => {
    turnUsage.inputTokens += u.inputTokens;
    turnUsage.outputTokens += u.outputTokens;
    turnUsage.cachedInputTokens += u.cachedInputTokens;
    turnUsage.cost += u.cost;
    cumulativeUsage.inputTokens += u.inputTokens;
    cumulativeUsage.outputTokens += u.outputTokens;
    cumulativeUsage.cachedInputTokens += u.cachedInputTokens;
    cumulativeUsage.cost += u.cost;
    bridge.updateUsage({ ...cumulativeUsage });
  };

  if (apiMode === "chat-completions") {
    if (!shouldPreserveChatReasoningContent(config.model, config.showThinking)) {
      for (const msg of state.chatHistory) {
        if (msg.role === "assistant" && "reasoning_content" in msg) {
          delete msg.reasoning_content;
        }
      }
    }

    microCompact(state.chatHistory);

    if (estimateTokens(state.chatHistory) > TOKEN_THRESHOLD) {
      bridge.pushAssistant("Context approaching limit, compacting conversation...");
      try {
        const compacted = await autoCompact(config.client, config.model, state.chatHistory);
        state.chatHistory.length = 0;
        state.chatHistory.push(...compacted.messages);
        state.compactCount += 1;
      } catch (error) {
        logApiError(caller, error, {
          api: "autoCompact",
          model: config.model,
          historyLength: state.chatHistory.length,
        });
        bridge.pushAssistant("⚠️ Compaction failed due to API error. Proceeding with raw history.");
      }
    }

    state.chatHistory.push({ role: "user", content: buildChatUserMessageContent(query, attachments) });
    try {
      await agentLoopWithChatCompletions(config, state.chatHistory, bridge, state, handlers, chatTools, control, onUsage, caller);
    } catch (error) {
      if (error instanceof TurnInterruptedError) {
        repairInterruptedToolCallHistory(state.chatHistory);
      }
      throw error;
    }
    return { usage: turnUsage, elapsedMs: Date.now() - startedAt };
  }

  if (state.turnCount > 1 && (state.turnCount - 1) % RESPONSES_COMPACT_INTERVAL === 0) {
    bridge.pushAssistant("Compacting Responses API context chain...");
    if (state.responseHistory.length > 0) {
      try {
        const compacted = await autoCompactResponseHistory(
          config.client,
          config.model,
          state.responseHistory,
        );
        state.responseHistory = compacted.messages;
        /**
         * 仅 stateful provider 需要额外保存待注入的 compact 摘要。
         *
         * 为什么 stateless replay 不需要：
         * - stateless 分支下一轮会直接发送 `state.responseHistory`，其中已经包含 compact summary。
         * - stateful 分支不会默认重放本地历史，所以切链后的第一轮必须显式把摘要带回请求里。
         */
        state.pendingCompactedContext = config.supportsPreviousResponseId
          ? compacted.continuationMessage
          : undefined;
        state.previousResponseId = undefined;
        state.compactCount += 1;
      } catch (error) {
        logApiError(caller, error, {
          api: "autoCompactResponseHistory",
          model: config.model,
          historyLength: state.responseHistory.length,
        });
        bridge.pushAssistant("⚠️ Responses API context compaction failed. Proceeding with raw history.");
      }
    }
  }

  const pendingCompactedContext = state.pendingCompactedContext;
  const responsesQuery = pendingCompactedContext
    ? buildCompactedResponsesQuery(pendingCompactedContext, query)
    : query;

  try {
    state.previousResponseId = await agentLoop(
      config,
      responsesQuery,
      attachments,
      state.previousResponseId,
      bridge,
      state,
      handlers,
      responseTools,
      control,
      onUsage,
      caller,
    );
    state.pendingCompactedContext = undefined;
  } catch (error) {
    if (error instanceof TurnInterruptedError && error.responseId) {
      state.previousResponseId = error.responseId;
      state.pendingCompactedContext = undefined;
    }
    throw error;
  }
  return { usage: turnUsage, elapsedMs: Date.now() - startedAt };
}

export type AgentConfig = {
  client: OpenAI;
  model: string;
  // Provider + model identifiers needed by the headless sub-agent child to
  // re-resolve auth from persisted config in its own process.
  providerName: string;
  modelName: string;
  system: string;
  showThinking: boolean;
  apiMode: "responses" | "chat-completions";
  supportsPreviousResponseId: boolean;
};

export type TurnResult = {
  usage: TokenUsage;
  elapsedMs: number;
};

export async function runAgentTurn(
  config: AgentConfig,
  query: string,
  attachments: ImageAttachment[],
  state: AgentState,
  bridge: UiBridge,
  control?: RunControl,
): Promise<TurnResult> {
  const runtime = await prepareToolRuntime(buildLeadHandlers(config, bridge, state), TOOLS, CHAT_TOOLS);
  return await runTurn(config, query, attachments, state, bridge, runtime.handlers, runtime.responseTools, runtime.chatTools, control);
}
