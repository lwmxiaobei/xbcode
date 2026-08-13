/**
 * read_file / write_file / edit_file 的实现。
 *
 * 三个工具共用两条约定：
 * - 所有写操作都经过 withFileMutationQueue，同一文件的并发写被压成串行。
 * - 文件系统访问全部走 `operations`，替换掉即可把工具接到远端（SSH、容器）上，
 *   不必改动工具本身的逻辑。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { modelSupportsImages } from "../agent/model-pricing.js";
import type { ImageAttachment, ToolResult } from "../types.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type Edit,
} from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "./file-truncate.js";
import {
  base64ByteLength,
  detectSupportedImageMimeTypeFromFile,
  formatDimensionNote,
  MAX_IMAGE_BASE64_BYTES,
  readImageDimensions,
  type SupportedImageMimeType,
} from "./image.js";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.js";

export type FileToolControl = {
  model?: string;
  pendingImages?: ImageAttachment[];
};

// --- 可替换的文件系统操作 ----------------------------------------------------

export type ReadOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** 可读性检查，不可读时抛错 */
  access: (absolutePath: string) => Promise<void>;
  /** 探测图片类型，非图片返回 null */
  detectImageMimeType?: (absolutePath: string) => Promise<SupportedImageMimeType | null>;
};

export type WriteOperations = {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
};

export type EditOperations = {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** 可读且可写检查，不满足时抛错 */
  access: (absolutePath: string) => Promise<void>;
};

const defaultReadOperations: ReadOperations = {
  readFile: (p) => fsp.readFile(p),
  access: (p) => fsp.access(p, fs.constants.R_OK),
  detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

const defaultWriteOperations: WriteOperations = {
  writeFile: (p, content) => fsp.writeFile(p, content, "utf8"),
  mkdir: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
};

const defaultEditOperations: EditOperations = {
  readFile: (p) => fsp.readFile(p),
  writeFile: (p, content) => fsp.writeFile(p, content, "utf8"),
  access: (p) => fsp.access(p, fs.constants.R_OK | fs.constants.W_OK),
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- read_file ---------------------------------------------------------------

function buildImageOutput(
  buffer: Buffer,
  mimeType: SupportedImageMimeType,
  absolutePath: string,
  control?: FileToolControl,
): string {
  const notes: string[] = [`Read image file [${mimeType}]`];

  const dimensionNote = formatDimensionNote(readImageDimensions(buffer, mimeType));
  if (dimensionNote) notes.push(dimensionNote);

  const model = control?.model;
  if (model && !modelSupportsImages(model)) {
    notes.push(`[Current model (${model}) does not accept image input. The image was not attached.]`);
    return notes.join("\n");
  }

  const encodedBytes = base64ByteLength(buffer.byteLength);
  if (encodedBytes > MAX_IMAGE_BASE64_BYTES) {
    notes.push(
      `[Image omitted: ${formatSize(encodedBytes)} once encoded, over the ${formatSize(MAX_IMAGE_BASE64_BYTES)} inline limit. Resize it first, e.g. bash: sips -Z 2000 "${absolutePath}" --out /tmp/resized.png]`,
    );
    return notes.join("\n");
  }

  if (!control?.pendingImages) {
    // 没有承接队列（例如工具被单独调用做测试）时，只能退化成文字说明。
    notes.push("[Image could not be attached in this context.]");
    return notes.join("\n");
  }

  control.pendingImages.push({
    path: absolutePath,
    mimeType,
    base64Data: buffer.toString("base64"),
  });
  notes.push("[Image attached to the conversation.]");
  return notes.join("\n");
}

function buildTextOutput(
  text: string,
  filePath: string,
  offset: number | undefined,
  limit: number | undefined,
): string {
  const allLines = text.split("\n");
  const totalFileLines = allLines.length;

  // offset 对外是 1-indexed（和编辑器、sed 一致），内部转成 0-indexed。
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    return `Error: offset ${offset} is beyond end of file (${totalFileLines} lines total).`;
  }

  let selected: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selected = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selected = allLines.slice(startLine).join("\n");
  }

  const truncation = truncateHead(selected);

  // 单行就超过字节上限：一行完整内容都给不出来，直接指一条 bash 退路，
  // 否则模型只会反复重试同一个 read 调用。
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf8"));
    return `[Line ${startLineDisplay} is ${firstLineSize}, over the ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${filePath} | head -c ${DEFAULT_MAX_BYTES}]`;
  }

  // 截断时把「下一次该传什么 offset」直接算好，模型照抄即可继续读。
  if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    const limitNote =
      truncation.truncatedBy === "lines"
        ? `${DEFAULT_MAX_LINES} line limit`
        : `${formatSize(DEFAULT_MAX_BYTES)} limit`;
    return `${truncation.content}\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${limitNote}). Use offset=${nextOffset} to continue.]`;
  }

  if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    return `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  }

  return truncation.content;
}

export async function runRead(
  filePath: string,
  options: { offset?: number; limit?: number } = {},
  control?: FileToolControl,
  cwd: string = process.cwd(),
  operations: ReadOperations = defaultReadOperations,
): Promise<string> {
  try {
    const absolutePath = await resolveReadPathAsync(filePath, cwd);
    await operations.access(absolutePath);

    const mimeType = operations.detectImageMimeType ? await operations.detectImageMimeType(absolutePath) : null;
    if (mimeType) {
      const buffer = await operations.readFile(absolutePath);
      return buildImageOutput(buffer, mimeType, absolutePath, control);
    }

    const buffer = await operations.readFile(absolutePath);
    return buildTextOutput(buffer.toString("utf8"), filePath, options.offset, options.limit);
  } catch (error) {
    return `Error: ${toErrorMessage(error)}`;
  }
}

// --- write_file --------------------------------------------------------------

export async function runWrite(
  filePath: string,
  content: string,
  cwd: string = process.cwd(),
  operations: WriteOperations = defaultWriteOperations,
): Promise<string> {
  const absolutePath = resolveToCwd(filePath, cwd);
  try {
    return await withFileMutationQueue(absolutePath, async () => {
      await operations.mkdir(path.dirname(absolutePath));
      await operations.writeFile(absolutePath, content);
      return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
    });
  } catch (error) {
    return `Error: ${toErrorMessage(error)}`;
  }
}

// --- edit_file ---------------------------------------------------------------

export async function runEdit(
  filePath: string,
  edits: Edit[],
  cwd: string = process.cwd(),
  operations: EditOperations = defaultEditOperations,
): Promise<ToolResult> {
  const absolutePath = resolveToCwd(filePath, cwd);

  try {
    return await withFileMutationQueue(absolutePath, async () => {
      try {
        await operations.access(absolutePath);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
        throw new Error(`Could not edit ${filePath}${code ? ` (${code})` : ""}.`);
      }

      const raw = (await operations.readFile(absolutePath)).toString("utf8");

      // 匹配前先剥 BOM、统一成 LF：模型给的 old_text 里既不会有不可见的 BOM，
      // 也不会精确复现 CRLF。写回时再把两者还原，避免整文件级的假 diff。
      const { bom, text: content } = stripBom(raw);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);

      const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, filePath);

      await operations.writeFile(absolutePath, bom + restoreLineEndings(newContent, originalEnding));

      const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);
      return {
        output: `Edited ${filePath} (${edits.length} block${edits.length > 1 ? "s" : ""} replaced)`,
        details: {
          diff,
          patch: generateUnifiedPatch(filePath, baseContent, newContent),
          firstChangedLine,
        },
      };
    });
  } catch (error) {
    return { output: `Error: ${toErrorMessage(error)}` };
  }
}

/**
 * 把 edit_file 的入参归一成 edits 数组。
 *
 * 兼容三种形态：
 * - 新形态 `edits: [{ old_text, new_text }]`
 * - 旧形态 `old_text` / `new_text` 直接放在顶层（历史会话回放、老 prompt 仍在用）
 * - 某些模型会把 edits 整个序列化成 JSON 字符串发过来
 */
export function normalizeEditArgs(args: Record<string, unknown>): Edit[] | null {
  let rawEdits = args.edits;

  if (typeof rawEdits === "string") {
    try {
      const parsed = JSON.parse(rawEdits);
      if (Array.isArray(parsed)) rawEdits = parsed;
    } catch {
      // 解析失败就当没有 edits，下面回落到顶层 old_text/new_text。
    }
  }

  const edits: Edit[] = [];
  if (Array.isArray(rawEdits)) {
    for (const item of rawEdits) {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      const oldText = entry.old_text ?? entry.oldText;
      const newText = entry.new_text ?? entry.newText;
      if (typeof oldText !== "string" || typeof newText !== "string") return null;
      edits.push({ oldText, newText });
    }
  }

  const legacyOld = args.old_text;
  const legacyNew = args.new_text;
  if (typeof legacyOld === "string" && typeof legacyNew === "string") {
    edits.push({ oldText: legacyOld, newText: legacyNew });
  }

  return edits.length > 0 ? edits : null;
}
