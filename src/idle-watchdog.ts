/**
 * Idle watchdog for SSE streams.
 *
 * 解决的痛点：
 * - 服务端建立 TCP 后长时间不发任何 SSE event（中转网关缓冲、provider 排队、
 *   reasoning 模型在 thinking 阶段不分块输出 reasoning_content），客户端 SDK 的
 *   `for await` 会无限阻塞。undici 默认 5 分钟才会因为 bodyTimeout 抛错。
 * - mimo / DeepSeek-R / Qwen-R1 这类 reasoning 模型在 chat-completions 兼容端点上
 *   尤其常见——观察到 idle > 130s 仍未恢复。
 *
 * 工作方式：
 * - 提供一个 AbortController 的 signal，stream 创建时与 user signal 组合传给 SDK。
 * - 每收到一个 stream event 调 `reset()` 重置定时器；超时未 reset 就 abort。
 * - `triggered` 让 catch 块能区分 "watchdog 触发的 abort" vs "用户 Esc abort"。
 *
 * 为什么写一个独立 helper 而不是直接 inline：
 * - 计时逻辑可以独立用快速假 timer 测试，避免给 stream 函数加难以验证的并发分支。
 * - streamResponse 和 streamChatCompletion 两份代码可以复用同一份语义。
 */
export type IdleWatchdog = {
  readonly signal: AbortSignal;
  readonly triggered: boolean;
  reset(): void;
  disarm(): void;
};

export function createIdleWatchdog(timeoutMs: number): IdleWatchdog {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let triggered = false;

  const disabled = !Number.isFinite(timeoutMs) || timeoutMs <= 0;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const reset = () => {
    if (disabled) return;
    clearTimer();
    timer = setTimeout(() => {
      triggered = true;
      // 不传 reason —— undici 在某些版本里会把 reason 直接挂在 cause 上，
      // 我们希望 catch 块通过 `triggered` 标志判断，而不是 sniff 错误对象。
      controller.abort();
    }, timeoutMs);
  };

  const disarm = () => {
    clearTimer();
  };

  return {
    signal: controller.signal,
    get triggered() {
      return triggered;
    },
    reset,
    disarm,
  };
}

/**
 * 解析 STREAM_IDLE_TIMEOUT_MS 环境变量。
 *
 * 默认 30s：
 * - 对响应快的普通模型（GPT/DeepSeek-V 等）来说，30s 没动静大概率就是真卡死，
 *   越早重试越好。
 * - 对 reasoning 模型（mimo / DeepSeek-R / Qwen-R1）则**偏激进**——thinking 阶段
 *   不持续吐 chunk 时会误杀。这类模型建议在 .env 里单独调大：
 *     STREAM_IDLE_TIMEOUT_MS=300000   # 5 分钟
 *   或干脆禁用：
 *     STREAM_IDLE_TIMEOUT_MS=0
 *
 * 负数视为"禁用"（=0），而不是"使用默认"——明确意图，避免歧义。
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export function parseIdleTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_IDLE_TIMEOUT_MS;
  if (parsed < 0) return 0;
  return Math.floor(parsed);
}

export function getStreamIdleTimeoutMs(): number {
  return parseIdleTimeoutMs(process.env.STREAM_IDLE_TIMEOUT_MS);
}

/**
 * Combine 0..N AbortSignals into a single signal that fires when any source does.
 *
 * 为什么自己实现：`AbortSignal.any` 是 Node 20.3+ 才稳定，package.json 只约束 >=20。
 * 为兼容 20.0~20.2 这种小众环境，做一个 listener-based fallback。
 */
export function combineAbortSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const filtered = signals.filter((s): s is AbortSignal => Boolean(s));
  if (filtered.length === 0) return undefined;
  if (filtered.length === 1) return filtered[0];
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(filtered);

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of filtered) {
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}
