import OpenAI from "openai";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ChatMessage } from "./types.js";

const KEEP_RECENT = 3;
const TOKEN_THRESHOLD = 50000;
const TRANSCRIPT_DIR = ".transcripts";

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
 * Layer 2: Auto-Compact
 * Save full history to disk, then LLM-summarize and replace history.
 */
export async function autoCompact(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  saveTranscript(messages);

  const historyText = JSON.stringify(messages).slice(0, 80000);
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: `Summarize the following conversation for continuity. Preserve: current task goals, key decisions made, file paths mentioned, code changes done, and any pending work. Be concise but complete.\n\n${historyText}`,
      },
    ],
    max_tokens: 2000,
  });

  const summary = response.choices[0]?.message?.content ?? "No summary generated.";

  return [
    { role: "user", content: `[Compressed conversation history]\n\n${summary}` },
    { role: "assistant", content: "Understood. I have the context from our previous conversation. Continuing." },
  ];
}

function saveTranscript(messages: ChatMessage[]): void {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filename = `transcript_${Date.now()}.jsonl`;
  const content = messages.map(m => JSON.stringify(m)).join("\n");
  writeFileSync(join(TRANSCRIPT_DIR, filename), content, "utf-8");
}

export { TOKEN_THRESHOLD };
