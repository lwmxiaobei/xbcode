import OpenAI from "openai";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ChatMessage, ResponseInputItem } from "./types.js";

const KEEP_RECENT = 10;
const TOKEN_THRESHOLD = 50000;
const TRANSCRIPT_DIR = ".transcripts";
const COMPACT_INPUT_CHAR_LIMIT = 120000;
const RECENT_USER_MESSAGE_COUNT = 2;
const RECENT_MESSAGE_FALLBACK_COUNT = 6;

export type AutoCompactResult<TMessage extends Record<string, unknown>> = {
  messages: TMessage[];
  summary: string;
  transcriptPath: string;
};

/** Rough token estimate: ~4 chars ≈ 1 token */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Layer 1: Micro-Compact
 * Replace old tool result content with placeholders (in-place).
 */
export function microCompact(messages: ChatMessage[]): void {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      toolIndices.push(i);
    }
  }

  if (toolIndices.length <= KEEP_RECENT) return;

  const toReplace = toolIndices.slice(0, -KEEP_RECENT);
  for (const idx of toReplace) {
    const msg = messages[idx];
    const content = String(msg.content ?? "");
    if (content.length > 100) {
      const toolName = findToolName(messages, idx);
      msg.content = `[Previous: used ${toolName}]`;
    }
  }
}

function findToolName(messages: ChatMessage[], toolIdx: number): string {
  const toolCallId = messages[toolIdx].tool_call_id;
  if (!toolCallId) return "unknown";

  for (let i = toolIdx - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as any[]) {
        if (tc.id === toolCallId) {
          return tc.function?.name ?? "unknown";
        }
      }
    }
  }
  return "unknown";
}

/**
 * 识别一条本地历史记录是否代表“用户发言”的边界。
 *
 * 为什么需要统一这个判断：
 * - chat-completions 和 responses 两种模式的历史结构不同，但“最近若干轮用户消息之后保留原文”
 *   这个策略是共通的。
 * - 压缩时如果从 assistant/tool 中间截断，后续上下文很容易出现孤立的工具结果或失去最近任务的起点。
 * - 把边界判断集中在这里，能让两种 API 模式复用同一套保留策略，而不是各写一套分叉逻辑。
 */
function isUserBoundaryMessage(message: Record<string, unknown>): boolean {
  return String(message.role ?? "") === "user";
}

/**
 * 计算压缩时应该保留原文的最近消息区间起点。
 *
 * 为什么采用“最近两条用户消息边界”：
 * - 相比简单保留最后 N 条消息，按用户消息切可以更稳定地保住最近完整任务上下文。
 * - 最近一条用户消息往往只包含当前追问，保留最近两条通常能覆盖“当前问题 + 紧邻上一轮背景”。
 * - 当历史里用户消息太少时，再退化成固定保留最后若干条，避免把整段对话都压成摘要。
 */
function findRecentMessagesStart<TMessage extends Record<string, unknown>>(messages: TMessage[]): number {
  let seenUserMessages = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isUserBoundaryMessage(messages[index])) {
      continue;
    }
    seenUserMessages += 1;
    if (seenUserMessages >= RECENT_USER_MESSAGE_COUNT) {
      return index;
    }
  }

  return Math.max(0, messages.length - RECENT_MESSAGE_FALLBACK_COUNT);
}

/**
 * 把待压缩历史拆成“需要总结的旧前缀”和“原样保留的最近后缀”。
 *
 * 为什么单独抽这个步骤：
 * - 旧实现是整段历史一次性总结，导致最近最关键的原文也被吃掉。
 * - 压缩后保留最近原文，可以显著降低摘要漂移，并保住最近的工具调用、错误信息和用户最新要求。
 * - 两种 API 模式都依赖这一步，所以这里返回通用的前后缀结构，而不是直接拼装最终消息。
 */
function splitMessagesForCompaction<TMessage extends Record<string, unknown>>(messages: TMessage[]): {
  olderMessages: TMessage[];
  recentMessages: TMessage[];
} {
  if (messages.length <= RECENT_MESSAGE_FALLBACK_COUNT) {
    return {
      olderMessages: messages.slice(0, Math.max(0, messages.length - 1)),
      recentMessages: messages.slice(Math.max(0, messages.length - 1)),
    };
  }

  const recentStart = findRecentMessagesStart(messages);
  return {
    olderMessages: messages.slice(0, recentStart),
    recentMessages: messages.slice(recentStart),
  };
}

/**
 * 生成用于 continuity 的压缩摘要正文。
 *
 * 为什么额外附带 transcript 路径：
 * - 摘要永远是有损的，复杂报错、精确代码片段、长工具输出不适合全部塞回上下文。
 * - 给模型一个可回溯的 transcript 路径，能在必要时重新读取细节，而不必默认把所有内容都塞进 summary。
 * - 同一段文字会同时用于 chat 历史替换和 responses 切链续接，统一文案可以减少两条路径的语义偏差。
 */
function buildCompressedHistoryText(summary: string, transcriptPath: string): string {
  return [
    "[Compressed conversation history]",
    "",
    summary,
    "",
    `Full transcript saved at: ${transcriptPath}`,
  ].join("\n");
}

/**
 * 为压缩请求构建结构化总结提示词。
 *
 * 为什么不用简单一句“请总结”：
 * - compact 的目标不是泛化摘要，而是让后续模型继续工作，因此需要强约束保留任务、文件、修改、错误和待办。
 * - 明确要求“recent preserved messages already remain verbatim”，可以避免摘要重复最近上下文，节省后续 token。
 * - 这里仍然保持提示词简短，避免为了生成摘要本身再把 compaction 请求做得过重。
 */
function buildCompactPrompt(serializedHistory: string): string {
  return [
    "Summarize the older portion of the following conversation for continuity.",
    "The most recent messages will remain verbatim after compaction, so focus on preserving durable context only.",
    "Preserve exactly these items when present:",
    "- current task goals and user intent",
    "- key decisions and constraints",
    "- file paths, functions, APIs, and code changes",
    "- important tool findings, errors, and fixes",
    "- pending work and the exact point where work should resume",
    "Be concise but complete.",
    "",
    serializedHistory,
  ].join("\n");
}

/**
 * 调用模型生成旧前缀摘要。
 *
 * 为什么只序列化“待总结前缀”：
 * - 最近消息会保留原文，重复发送它们只会浪费 compact request 的输入预算。
 * - 旧实现只截取整段 JSON 的前 80k 字符，容易把最近上下文直接丢掉；现在改成先分段，再截旧前缀。
 * - 这里仍保留字符上限，避免极端长历史让 compact 请求本身再次超长。
 */
async function summarizeOlderMessages<TMessage extends Record<string, unknown>>(
  client: OpenAI,
  model: string,
  messages: TMessage[],
): Promise<string> {
  const serializedHistory = JSON.stringify(messages).slice(0, COMPACT_INPUT_CHAR_LIMIT);
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: buildCompactPrompt(serializedHistory),
      },
    ],
    max_tokens: 2000,
  });

  return response.choices[0]?.message?.content ?? "No summary generated.";
}

/**
 * 构造 chat-completions 模式压缩后的历史。
 *
 * 为什么采用“摘要消息 + 最近原文”的结构：
 * - 第一条 user summary 给模型一个稳定的 continuity 入口。
 * - 紧跟一条 assistant 确认消息，能把“这是一段承接上下文”固定成对话状态，而不是裸插一段文本。
 * - 最近消息保留原文，可以让后续推理直接接在最新真实上下文后面，而不是完全依赖摘要复述。
 */
function buildCompactedChatHistory(
  summary: string,
  transcriptPath: string,
  recentMessages: ChatMessage[],
): ChatMessage[] {
  return [
    { role: "user", content: buildCompressedHistoryText(summary, transcriptPath) },
    { role: "assistant", content: "Understood. I will continue from the preserved recent context." },
    ...recentMessages.map((message) => ({ ...message })),
  ];
}

/**
 * 构造 responses 模式本地 replay 历史里的压缩结果。
 *
 * 为什么也保留最近原文 replay items：
 * - stateless replay 分支会直接把本地 `responseHistory` 重发给模型，如果压缩后只剩摘要，会把最近细节全部抹平。
 * - 对支持 `previous_response_id` 的分支，这份 replay 历史虽然默认不直接发送，但仍用于本地估算、手动 compact 和 resume。
 * - 保留最近 replay items 让两种 responses 子路径在 compact 后拥有一致的“摘要旧前缀 + 原文最近后缀”语义。
 */
function buildCompactedResponseHistory(
  summary: string,
  transcriptPath: string,
  recentMessages: ResponseInputItem[],
): ResponseInputItem[] {
  return [
    {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: buildCompressedHistoryText(summary, transcriptPath),
        },
      ],
    },
    ...recentMessages.map((message) => ({ ...message })),
  ];
}

/**
 * Layer 2: Auto-Compact for chat-completions mode.
 *
 * 为什么保留最近原文而不是完全替换成摘要：
 * - 最近上下文最容易影响下一步动作，直接保留能显著降低压缩后的行为漂移。
 * - 旧前缀仍然通过摘要保留下来，整体 token 体积会比原始全量历史小很多。
 * - 返回结构化结果而不是裸消息数组，方便 responses 模式复用同一次摘要逻辑。
 */
export async function autoCompact(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
): Promise<AutoCompactResult<ChatMessage>> {
  const transcriptPath = saveTranscript(messages);
  const { olderMessages, recentMessages } = splitMessagesForCompaction(messages);
  const summarySource = olderMessages.length > 0 ? olderMessages : messages;
  const summary = await summarizeOlderMessages(client, model, summarySource);

  return {
    messages: buildCompactedChatHistory(summary, transcriptPath, recentMessages),
    summary,
    transcriptPath,
  };
}

/**
 * 为 responses 模式生成压缩后的本地 replay 历史和续接文本。
 *
 * 为什么额外返回 continuationMessage：
 * - 支持 `previous_response_id` 的 providers 不会默认重放本地历史，所以切链后必须把摘要主动注入下一轮用户输入。
 * - 不支持 `previous_response_id` 的 stateless replay 路径则直接使用压缩后的 `messages` 即可。
 * - 两条路径共用同一份 summary，可以避免 stateful/stateless 在 compact 后看到不同语义的上下文。
 */
export async function autoCompactResponseHistory(
  client: OpenAI,
  model: string,
  messages: ResponseInputItem[],
): Promise<AutoCompactResult<ResponseInputItem> & { continuationMessage: string }> {
  const transcriptPath = saveTranscript(messages);
  const { olderMessages, recentMessages } = splitMessagesForCompaction(messages);
  const summarySource = olderMessages.length > 0 ? olderMessages : messages;
  const summary = await summarizeOlderMessages(client, model, summarySource);
  const continuityMessage = buildCompressedHistoryText(summary, transcriptPath);

  return {
    messages: buildCompactedResponseHistory(summary, transcriptPath, recentMessages),
    summary,
    transcriptPath,
    continuationMessage: continuityMessage,
  };
}

/**
 * 把完整历史落盘成 JSONL transcript。
 *
 * 为什么返回具体路径：
 * - compact 后需要把 transcript 路径带回 summary/continuity 文本，方便后续按需回读细节。
 * - responses 和 chat 两条压缩路径都要引用这个路径，直接返回可避免调用方重复拼接。
 * - 保持 append-only 文件名规则不变，可以兼容现有的人工排查习惯。
 */
function saveTranscript(messages: Record<string, unknown>[]): string {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filename = `transcript_${Date.now()}.jsonl`;
  const content = messages.map(m => JSON.stringify(m)).join("\n");
  const filePath = join(TRANSCRIPT_DIR, filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

export { TOKEN_THRESHOLD };
