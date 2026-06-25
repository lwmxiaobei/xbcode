import type { TokenUsage } from "../types.js";
import { calculateCost } from "./model-pricing.js";

/**
 * 从一次 API 响应的 usage 字段提取标准化的 TokenUsage。
 *
 * 兼容 Responses API（input_tokens/output_tokens）与 Chat Completions
 * （prompt_tokens/completion_tokens）两套字段名；缓存命中数同理。
 * 费用按 `model` 查单价表计算（见 model-pricing.ts），多模型下更准确。
 */
export function extractTokenUsage(usage: any, model: string): TokenUsage {
  const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
  const cachedInputTokens = Number(
    usage?.input_token_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const cost = calculateCost(model, inputTokens, outputTokens, cachedInputTokens);
  return { inputTokens, outputTokens, cachedInputTokens, cost };
}
