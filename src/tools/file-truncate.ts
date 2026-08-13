/**
 * 文件读取的截断策略。
 *
 * 和 src/truncate.ts 的「按 token 预算做中间截断」是两回事：
 * - src/truncate.ts 服务于 bash/grep 这类输出，关心的是别撑爆上下文，
 *   所以保留头尾、砍掉中间。
 * - 这里服务于 read_file，关心的是「从 offset 开始顺序读到哪一行」，
 *   因此必须从头截断，且要能算出下一次该传的 offset。
 *
 * 两个上限相互独立，谁先触发算谁：
 * - 行数上限（默认 2000 行）
 * - 字节上限（默认 50KB）
 *
 * 永远不返回半行 —— 半行会让模型误以为看到了完整语句。
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export type TruncationResult = {
  /** 截断后的内容 */
  content: string;
  /** 是否发生了截断 */
  truncated: boolean;
  /** 触发的是哪个上限 */
  truncatedBy: "lines" | "bytes" | null;
  /** 原始内容总行数 */
  totalLines: number;
  /** 原始内容总字节数 */
  totalBytes: number;
  /** 输出的完整行数 */
  outputLines: number;
  /** 输出的字节数 */
  outputBytes: number;
  /** 第一行本身就超出字节上限（无法输出任何完整行） */
  firstLineExceedsLimit: boolean;
  /** 实际生效的行数上限 */
  maxLines: number;
  /** 实际生效的字节上限 */
  maxBytes: number;
};

export type TruncationOptions = {
  maxLines?: number;
  maxBytes?: number;
};

function splitLinesForCounting(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split("\n");
  // 末尾换行不算一个空行，否则每个正常文件都会多出一行。
  if (content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 从头截断，保留前 N 行 / N 字节。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = splitLinesForCounting(content);
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  // 第一行就超过字节上限（压缩后的 js、单行大 json）：一行都给不出来。
  // 这时不是硬失败，调用方会据此给出 sed 之类的退路。
  const firstLineBytes = lines.length > 0 ? Buffer.byteLength(lines[0], "utf8") : 0;
  if (firstLineBytes > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  const kept: string[] = [];
  let keptBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    // i > 0 时要把行间的换行符也算进去。
    const lineBytes = Buffer.byteLength(line, "utf8") + (i > 0 ? 1 : 0);
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    keptBytes += lineBytes;
  }

  if (kept.length >= maxLines && keptBytes <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = kept.join("\n");
  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: kept.length,
    outputBytes: Buffer.byteLength(outputContent, "utf8"),
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}
