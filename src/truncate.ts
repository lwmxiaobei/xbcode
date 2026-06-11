import { getEncoding, encodingForModel } from "js-tiktoken";

const DEFAULT_TOKEN_LIMIT = 12_000;

/**
 * Try to resolve a tokenizer encoding for the given model.
 * Falls back to cl100k_base for unknown models since it's the closest
 * approximation for modern GPT models.
 */
function resolveEncoding(modelId?: string) {
  if (modelId) {
    try {
      return encodingForModel(modelId as Parameters<typeof encodingForModel>[0]);
    } catch {
      // fall through
    }
  }
  return getEncoding("cl100k_base");
}

/**
 * Count tokens in a string using the model-appropriate tokenizer.
 */
export function countTokens(text: string, modelId?: string): number {
  const enc = resolveEncoding(modelId);
  const tokens = enc.encode(text);
  return tokens.length;
}

/**
 * Truncate text by removing the middle portion, keeping head and tail.
 *
 * If `text` fits within `maxTokens`, it's returned unchanged.
 * Otherwise, the text is split evenly: half the budget for the head,
 * half for the tail, connected by a marker like `…N tokens truncated…`.
 *
 * @returns `{ text, truncatedTokens | undefined }`
 */
export function truncateMiddleWithTokenBudget(
  text: string,
  maxTokens: number = DEFAULT_TOKEN_LIMIT,
  modelId?: string,
): { text: string; truncatedTokens?: number } {
  const enc = resolveEncoding(modelId);
  const tokens = enc.encode(text);

  if (tokens.length <= maxTokens) {
    return { text };
  }

  const truncated = tokens.length - maxTokens;
  const headBudget = Math.floor(maxTokens / 2);
  const tailBudget = maxTokens - headBudget;

  const headTokens = tokens.slice(0, headBudget);
  const tailTokens = tokens.slice(tokens.length - tailBudget);

  const headText = enc.decode(headTokens);
  const tailText = enc.decode(tailTokens);

  // Decode/re-encode to get accurate byte count for the marker
  const marker = `\n…${truncated.toLocaleString()} tokens truncated…\n`;

  return {
    text: headText + marker + tailText,
    truncatedTokens: truncated,
  };
}