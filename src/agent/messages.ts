import path from "node:path";

import type { ChatMessage, ImageAttachment, ResponseInputItem } from "../types.js";

const INTERRUPTED_RESPONSES_CONTEXT_LIMIT = 60_000;

export function getResponseContentKey(outputIndex: unknown, contentIndex: unknown): string {
  return `${String(outputIndex ?? "")}:${String(contentIndex ?? "")}`;
}

/**
 * Normalize Responses API input into the explicit list form expected by the
 * ChatGPT Codex backend.
 *
 * Why this exists:
 * - The public OpenAI Responses API accepts a plain string as shorthand input,
 *   but `chatgpt.com/backend-api/codex/responses` rejects that shortcut and
 *   requires `input` to be a list.
 * - Converting strings into a single user message preserves the original
 *   behavior while making the request shape compatible with both backends.
 * - Existing array inputs are forwarded unchanged so tool-call follow-up items
 *   and previous structured payloads keep their original form.
 */
export function normalizeResponseInput(inputItems: ResponseInputItem[] | string): ResponseInputItem[] {
  if (Array.isArray(inputItems)) {
    return inputItems;
  }

  return [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: inputItems,
        },
      ],
    },
  ];
}

/**
 * Build a canonical user-message item for stateless Responses replay.
 *
 * Why this exists:
 * - When `previous_response_id` is unavailable we must resend prior turns as an
 *   explicit input list, so user prompts need one stable shape.
 * - Keeping the constructor in one place avoids subtle inconsistencies between
 *   the first request of a turn and follow-up replay requests after tool calls.
 * - The same shape remains valid for providers that still support the public
 *   Responses API shorthand.
 */
export function buildResponseInputContent(text: string, attachments: ImageAttachment[] = []): ResponseInputItem[] {
  const content: ResponseInputItem[] = [
    {
      type: "input_text",
      text,
    },
  ];

  for (const attachment of attachments) {
    content.push({
      type: "input_image",
      image_url: `data:${attachment.mimeType};base64,${attachment.base64Data}`,
    });
  }

  return content;
}

export function buildUserResponseMessage(text: string, attachments: ImageAttachment[] = []): ResponseInputItem {
  return {
    type: "message",
    role: "user",
    content: buildResponseInputContent(text, attachments),
  };
}

export function buildAssistantResponseMessage(text: string): ResponseInputItem {
  return {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
      },
    ],
  };
}

/**
 * 在 Responses 模式切链后的首轮请求里，把 compact 摘要显式拼回用户输入。
 *
 * 为什么需要这一步：
 * - 支持 `previous_response_id` 的 provider 平时把上下文保存在服务端，不会自动重放本地 `responseHistory`。
 * - 一旦 compact 时主动断开旧链，如果下一轮只发送新的用户问题，模型就会失去 compact 前的连续性。
 * - 这里把 compact 摘要和当前用户请求合并成一条 user message，可以在不改请求协议的前提下恢复上下文。
 */
export function buildCompactedResponsesQuery(summary: string, query: string): string {
  return `${summary}\n\nCurrent user request:\n${query}`;
}

function truncateContextText(text: string, limit = INTERRUPTED_RESPONSES_CONTEXT_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n\n[truncated interrupted context: ${text.length - limit} chars omitted]`;
}

function formatResponseReplayItemForContext(item: ResponseInputItem): string {
  const type = String(item.type ?? "");
  if (type === "message") {
    const role = String(item.role ?? "unknown");
    return `${role}:\n${extractAssistantText(item.content)}`;
  }
  if (type === "function_call") {
    return `assistant tool call ${String(item.name ?? "unknown_tool")}:\n${String(item.arguments ?? "")}`;
  }
  if (type === "function_call_output") {
    return `tool result ${String(item.call_id ?? "")}:\n${String(item.output ?? "")}`;
  }
  return `${type || "item"}:\n${JSON.stringify(item)}`;
}

export function buildInterruptedResponsesContext(items: ResponseInputItem[]): string {
  const body = items
    .map((item, index) => `Item ${index + 1} ${formatResponseReplayItemForContext(item)}`)
    .join("\n\n");
  return truncateContextText([
    "The previous Responses API turn was interrupted before it could be committed to the server-side conversation chain.",
    "These model-visible items had already happened in that interrupted turn.",
    body,
    "If the current user asks to continue, continue from the interrupted turn instead of restarting the plan.",
  ].join("\n\n"));
}

export function buildChatUserMessageContent(text: string, attachments: ImageAttachment[] = []): string | Array<Record<string, unknown>> {
  if (attachments.length === 0) {
    return text;
  }

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text,
    },
  ];

  for (const attachment of attachments) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${attachment.mimeType};base64,${attachment.base64Data}`,
      },
    });
  }

  return content;
}

export function describeAttachments(attachments: ImageAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  return attachments
    .map((attachment, index) => `Image ${index + 1}: ${path.basename(attachment.path)}`)
    .join("\n");
}

const CHAT_REASONING_CONTENT_REQUIRED_MODEL_PATTERNS = [
  /^mimo(?:[-_.]|$)/i,
];

export function shouldPreserveChatReasoningContent(model: string, showThinking: boolean): boolean {
  if (!showThinking) {
    return false;
  }
  const normalizedModel = model.trim();
  return CHAT_REASONING_CONTENT_REQUIRED_MODEL_PATTERNS.some((pattern) => pattern.test(normalizedModel));
}

/**
 * Deep-clone replay items before reusing them in a later request.
 *
 * Why this exists:
 * - Response output objects come from the SDK and may be mutated elsewhere
 *   during rendering or debugging.
 * - Stateless replay should preserve the exact model-visible payload from the
 *   earlier round, not a shared object that another call could modify.
 * - JSON cloning is sufficient here because Responses items are plain data.
 */
export function cloneResponseReplayItem<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Keep only the output items that are valid and useful for stateless replay.
 *
 * Why this exists:
 * - The ChatGPT Codex backend rejects `previous_response_id`, so later rounds
 *   must be rebuilt from prior assistant messages and function calls.
 * - Message and function-call items are enough to reconstruct the model-visible
 *   assistant state; ephemeral bookkeeping items do not help and may be invalid
 *   when sent back as input.
 * - Returning cloned objects lets callers append the items directly into
 *   `responseHistory` without worrying about shared references.
 */
export function collectReplayableResponseOutput(output: unknown): ResponseInputItem[] {
  if (!Array.isArray(output)) {
    return [];
  }

  return output
    .filter((item): item is ResponseInputItem => {
      if (!item || typeof item !== "object") {
        return false;
      }
      const type = String((item as { type?: unknown }).type ?? "");
      return type === "message" || type === "function_call";
    })
    .map((item) => cloneResponseReplayItem(item));
}

export function extractAssistantText(content: unknown): string {
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

/**
 * 从 Responses API 的 `output` 里提取 assistant 文本。
 *
 * 为什么要单独做这一步：
 * - UI 实时渲染主要依赖 `response.output_text.delta`，但不同后端并不保证
 *   一定会把最终文本完整地以 delta 形式流出来。
 * - 某些响应会在 `finalResponse().output` 里携带完整 message 文本，同时还带
 *   function_call；如果这里只信任流式 delta，UI 就会出现“只看到工具，没有
 *   看到模型文字”的问题。
 * - 这里统一从最终 `output` 兜底提取，确保无论流事件是否完整，assistant
 *   文本都能被恢复。
 */
export function extractAssistantTextFromResponseOutput(output: unknown): string {
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .map((item: any) => {
      if (item?.type === "message" && item?.role === "assistant") {
        return extractAssistantText(item.content);
      }
      if (item?.type === "text") {
        return extractAssistantText(item.text);
      }
      return "";
    })
    .join("")
    .trim();
}

/**
 * 计算最终响应里还没有被 UI 显示出来的 assistant 文本增量。
 *
 * 为什么不是直接再次整段 push：
 * - 如果前半段文本已经通过 delta 渲染出来，直接整段补发会导致重复显示。
 * - 最常见的缺口是“完全没流出来”或“只缺最后一小段”，因此优先走前缀补齐，
 *   让 UI 尽量保持一条连续 assistant 消息。
 * - 如果最终文本和已流出的前缀完全对不上，说明后端事件形态和预期差异更大，
 *   这时返回整段完整文本，至少保证用户能看到模型真实回答。
 */
export function getMissingAssistantText(streamedText: string, finalText: string): string {
  const streamed = streamedText.trim();
  const finalized = finalText.trim();

  if (!finalized) {
    return "";
  }
  if (!streamed) {
    return finalized;
  }
  if (finalized === streamed) {
    return "";
  }
  if (finalized.startsWith(streamed)) {
    return finalized.slice(streamed.length);
  }
  return finalized;
}

export function repairInterruptedToolCallHistory(history: ChatMessage[]): void {
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

