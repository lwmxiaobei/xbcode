/**
 * Format the footer line shown while the agent is busy.
 *
 * 为什么要单独抽：
 * - UI 之前只有一行静态 "Working... Esc stops this turn."，无法区分"模型正在
 *   reasoning"、"网关把流缓冲住了"、"连接已死"这几种情况。
 * - 把"是否显示 idle 字段"以及"秒数取整"的规则抽成纯函数，UI 只负责按 1s tick
 *   触发重渲染，逻辑可以脱离 React 单独验证。
 *
 * 设计取舍：
 * - idle < 5s 不显示，避免抖动：流式 chunk 之间通常有几百毫秒到 1~2 秒的间隔，
 *   持续显示 "idle 1s" 反而干扰阅读。
 * - 一旦 idle ≥ 5s 就开始显示，让用户在 reasoning 长尾或网关 stall 时能立刻感知
 *   "还在等 / 等了多久"。
 */
const IDLE_DISPLAY_THRESHOLD_SECONDS = 5;

function clampToNonNegativeSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export function formatBusyStatus(elapsedSeconds: number, idleSeconds: number): string {
  const elapsed = clampToNonNegativeSeconds(elapsedSeconds);
  const idle = clampToNonNegativeSeconds(idleSeconds);

  if (idle >= IDLE_DISPLAY_THRESHOLD_SECONDS) {
    return `Working ${elapsed}s · idle ${idle}s · Esc to stop`;
  }
  return `Working ${elapsed}s · Esc to stop`;
}
