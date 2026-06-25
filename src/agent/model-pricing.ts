/**
 * 按模型的计费单价与上下文窗口表。
 *
 * 为什么单独成文件：
 * - 计费（usage.ts）和上下文占用显示（index.tsx 状态栏）都要按当前模型查表，
 *   把"模型 -> 价格/窗口"的知识集中一处，避免两边各写一份硬编码。
 * - 单价单位统一为 USD / 百万 token，和各家定价页保持一致，改价时一目了然。
 *
 * 匹配策略：按"最长前缀"匹配模型 id（如 `gpt-4.1-mini-2025-04-14` 命中 `gpt-4.1-mini`），
 * 命中不到时回落到 DEFAULT —— 保持引入本表前的老行为（2.0 / 0.5 / 8.0，128k 窗口），
 * 这样接入新模型只是"算得更准"，绝不会因为查不到表而报错或算成 0。
 */

export type ModelPricing = {
  /** USD / 百万 input token（未命中缓存的部分） */
  input: number;
  /** USD / 百万 cached input token */
  cachedInput: number;
  /** USD / 百万 output token */
  output: number;
};

export type ModelInfo = {
  pricing: ModelPricing;
  /** 上下文窗口大小（token），用于状态栏的占用百分比 */
  contextWindow: number;
};

const DEFAULT_INFO: ModelInfo = {
  pricing: { input: 2.0, cachedInput: 0.5, output: 8.0 },
  contextWindow: 128_000,
};

// key 为模型 id 前缀。更具体的前缀（更长）会优先命中，见 resolveModelInfo。
const MODEL_TABLE: Record<string, ModelInfo> = {
  // OpenAI GPT-4.1 家族（~1M 窗口）
  "gpt-4.1-nano": { pricing: { input: 0.1, cachedInput: 0.025, output: 0.4 }, contextWindow: 1_047_576 },
  "gpt-4.1-mini": { pricing: { input: 0.4, cachedInput: 0.1, output: 1.6 }, contextWindow: 1_047_576 },
  "gpt-4.1": { pricing: { input: 2.0, cachedInput: 0.5, output: 8.0 }, contextWindow: 1_047_576 },
  // OpenAI GPT-4o 家族（128k 窗口）
  "gpt-4o-mini": { pricing: { input: 0.15, cachedInput: 0.075, output: 0.6 }, contextWindow: 128_000 },
  "gpt-4o": { pricing: { input: 2.5, cachedInput: 1.25, output: 10.0 }, contextWindow: 128_000 },
  // OpenAI GPT-5 家族（400k 窗口）
  "gpt-5-nano": { pricing: { input: 0.05, cachedInput: 0.005, output: 0.4 }, contextWindow: 400_000 },
  "gpt-5-mini": { pricing: { input: 0.25, cachedInput: 0.025, output: 2.0 }, contextWindow: 400_000 },
  "gpt-5": { pricing: { input: 1.25, cachedInput: 0.125, output: 10.0 }, contextWindow: 400_000 },
  // OpenAI o 系列推理模型（200k 窗口）
  "o4-mini": { pricing: { input: 1.1, cachedInput: 0.275, output: 4.4 }, contextWindow: 200_000 },
  "o3-mini": { pricing: { input: 1.1, cachedInput: 0.55, output: 4.4 }, contextWindow: 200_000 },
  "o3": { pricing: { input: 2.0, cachedInput: 0.5, output: 8.0 }, contextWindow: 200_000 },
  "o1-mini": { pricing: { input: 1.1, cachedInput: 0.55, output: 4.4 }, contextWindow: 128_000 },
  "o1": { pricing: { input: 15.0, cachedInput: 7.5, output: 60.0 }, contextWindow: 200_000 },
  // DeepSeek（chat-completions 端，128k 窗口）
  "deepseek-reasoner": { pricing: { input: 0.55, cachedInput: 0.14, output: 2.19 }, contextWindow: 128_000 },
  "deepseek-chat": { pricing: { input: 0.27, cachedInput: 0.07, output: 1.1 }, contextWindow: 128_000 },
};

// 预先按前缀长度降序排好，匹配时第一个命中的就是最具体的。
const SORTED_PREFIXES = Object.keys(MODEL_TABLE).sort((a, b) => b.length - a.length);

export function resolveModelInfo(model: string): ModelInfo {
  const id = (model ?? "").trim().toLowerCase();
  for (const prefix of SORTED_PREFIXES) {
    if (id.startsWith(prefix)) return MODEL_TABLE[prefix];
  }
  return DEFAULT_INFO;
}

export function getContextWindow(model: string): number {
  return resolveModelInfo(model).contextWindow;
}

/** 按模型单价计算本次响应的费用（USD）。 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number {
  const { pricing } = resolveModelInfo(model);
  // OpenAI/DeepSeek 的 input_tokens 已经包含了命中缓存的部分，
  // 这里把缓存命中的 token 拆出来按更低的 cachedInput 单价计，剩余按 input 计。
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInput * pricing.input +
      cachedInputTokens * pricing.cachedInput +
      outputTokens * pricing.output) /
    1_000_000
  );
}
