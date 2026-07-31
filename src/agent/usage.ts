import type { TokenUsage } from "../types.js";
import { calculateCost, getPricingCurrency } from "./model-pricing.js";

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
    usage?.input_tokens_details?.cached_tokens ??
    usage?.input_token_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const nativeCost = calculateCost(model, inputTokens, outputTokens, cachedInputTokens);
  const currency = getPricingCurrency(model);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    // Keep the legacy scalar USD-only so old snapshots and callers do not
    // accidentally treat a CNY amount as dollars.
    cost: currency === "USD" ? nativeCost : 0,
    costs: {
      [currency]: nativeCost,
    },
  };
}

export function accumulateTokenUsage(target: TokenUsage, delta: TokenUsage): void {
  const existingCosts = target.costs ?? (target.cost > 0 ? { USD: target.cost } : {});
  const deltaCosts = delta.costs ?? (delta.cost > 0 ? { USD: delta.cost } : {});

  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.cost += delta.cost;

  for (const currency of ["USD", "CNY"] as const) {
    const amount = deltaCosts[currency];
    if (amount !== undefined) {
      existingCosts[currency] = (existingCosts[currency] ?? 0) + amount;
    }
  }
  target.costs = existingCosts;
}
