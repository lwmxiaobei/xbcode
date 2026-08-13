/**
 * edit_file 的匹配、替换与 diff 生成。
 *
 * 这一层的核心立场：宁可报错让模型重来，也不要「猜一个位置改下去」。
 * 旧实现用 content.replace(oldText, newText) 只替换第一处，当 old_text 在文件里
 * 出现多次时会静默改错地方，且返回值仍然是成功 —— 这是最难排查的一类 bug。
 */

import * as Diff from "diff";

export type Edit = {
  oldText: string;
  newText: string;
};

export type AppliedEditsResult = {
  baseContent: string;
  newContent: string;
};

export type FuzzyMatchResult = {
  found: boolean;
  /** 匹配起始下标，落在 contentForReplacement 的坐标系里 */
  index: number;
  matchLength: number;
  /** 是否走了模糊匹配（false 表示精确命中） */
  usedFuzzyMatch: boolean;
  /** 执行替换时应当基于的内容：精确匹配是原文，模糊匹配是归一化后的文本 */
  contentForReplacement: string;
};

type LineSpan = {
  start: number;
  end: number;
};

type MatchedEdit = {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
};

type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

// --- 行尾与 BOM -------------------------------------------------------------

// 取文件里第一个出现的行尾风格。CRLF 文件如果按 LF 写回，
// 整个文件都会变成「每行都改了」的假 diff，git 上尤其刺眼。
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** 剥掉 UTF-8 BOM。模型给的 old_text 里不会带这个不可见字符，匹配前必须先去掉。 */
const BOM = "\uFEFF";

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith(BOM) ? { bom: BOM, text: content.slice(1) } : { bom: "", text: content };
}

// --- 模糊匹配 ---------------------------------------------------------------

/**
 * 为模糊匹配做归一化。只处理「无歧义、可逆」的字符差异：
 * - 每行行尾空白（模型很少精确复现尾随空格）
 * - 弯引号 -> 直引号
 * - 各种 Unicode 破折号 -> ASCII 连字符
 * - 各种特殊空格 -> 普通空格
 *
 * 注意不碰行首缩进：Python/YAML 的缩进有语义，模糊掉会改变程序含义。
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // 弯单引号 -> 直单引号
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // 弯双引号 -> 直双引号
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // U+2010 连字符、U+2011 不换行连字符、U+2012 数字破折号、U+2013 en dash、
      // U+2014 em dash、U+2015 横线、U+2212 减号 -> ASCII 连字符
      .replace(/[\u2010-\u2015\u2212]/g, "-")
      // U+00A0 不换行空格、U+2002-U+200A 各种排版空格、U+202F 窄不换行空格、
      // U+205F 数学中等空格、U+3000 表意文字空格 -> 普通空格
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}

/**
 * 先精确匹配，失败再退到模糊匹配。
 * 模糊命中时返回的下标落在归一化后的坐标系里，调用方需要用同一坐标系做替换。
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content,
    };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent,
  };
}

// --- 替换应用 ---------------------------------------------------------------

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error("Replacement range is outside the base content.");
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error("Replacement range is outside the base content.");
  }

  return { startLine, endLine: endLine + 1 };
}

// 倒序应用替换：先改后面的，前面的下标才不会被前一次替换的长度变化带偏。
function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) +
      replacement.newText +
      result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * 把「基于归一化文本匹配出来的替换」应用回原始文本，同时保留未改动行的原始字节。
 *
 * 为什么需要这一步：一旦有任何一处走了模糊匹配，替换就发生在归一化坐标系里。
 * 如果直接把整个归一化结果写回文件，全文件的尾随空白、弯引号、特殊破折号都会
 * 被一起改掉 —— 一次小改动会污染成一个巨大的 diff。
 * 这里只把「真正被替换命中的那些行」按归一化结果重写，其余行原样从原文拷回。
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }

  // 把落在相邻/重叠行区间上的替换合并成组，组内一起重写。
  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sorted) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");

    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset,
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");

  return result;
}

// --- 错误信息 ---------------------------------------------------------------
//
// 错误文案要能让模型自己修复：说清是哪一条 edit、错在哪、下一步该做什么。

function getNotFoundError(filePath: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${filePath}. old_text must match exactly, including all whitespace and newlines. Read the file again to confirm the current content.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${filePath}. Its old_text must match exactly, including all whitespace and newlines. Read the file again to confirm the current content.`,
  );
}

function getDuplicateError(filePath: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of old_text in ${filePath}. It must match exactly one place. Add surrounding context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}].old_text in ${filePath}. Each old_text must match exactly one place. Add surrounding context to make it unique.`,
  );
}

function getEmptyOldTextError(filePath: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`old_text must not be empty in ${filePath}.`);
  }
  return new Error(`edits[${editIndex}].old_text must not be empty in ${filePath}.`);
}

function getNoChangeError(filePath: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${filePath}. The replacement produced identical content — old_text and new_text appear to be the same.`,
    );
  }
  return new Error(`No changes made to ${filePath}. The replacements produced identical content.`);
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

/**
 * 把一组替换应用到已归一化为 LF 的文本上。
 *
 * 所有 edit 都对同一份原始内容匹配（而不是对上一条 edit 的结果匹配），
 * 因此模型可以一次给出多处不相邻的改动而不必自己推演中间状态。
 * 三道校验：非空、唯一命中、彼此不重叠。任何一条不满足就整体失败，不落盘。
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  filePath: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i].oldText.length === 0) {
      throw getEmptyOldTextError(filePath, i, normalizedEdits.length);
    }
  }

  // 只要有任意一条需要模糊匹配，全部替换就统一在归一化坐标系里进行，
  // 否则不同 edit 的下标会落在两套坐标系上，无法一起倒序应用。
  const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
  const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i];
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) {
      throw getNotFoundError(filePath, i, normalizedEdits.length);
    }

    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(filePath, i, normalizedEdits.length, occurrences);
    }

    matchedEdits.push({
      editIndex: i,
      matchIndex: matchResult.index,
      matchLength: matchResult.matchLength,
      newText: edit.newText,
    });
  }

  // 重叠检测：两条 edit 命中区间相交时，倒序替换会互相破坏对方的文本，
  // 结果是一个谁都没预期到的中间态。这种情况直接拒绝。
  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1];
    const current = matchedEdits[i];
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge them into a single edit or target disjoint regions.`,
      );
    }
  }

  const baseContent = normalizedContent;
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
    : applyReplacements(replacementBaseContent, matchedEdits);

  if (baseContent === newContent) {
    throw getNoChangeError(filePath, normalizedEdits.length);
  }

  return { baseContent, newContent };
}

// --- diff 生成 --------------------------------------------------------------

/** 生成标准 unified patch，可直接喂给 `git apply` / `patch`。 */
export function generateUnifiedPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string {
  return Diff.createTwoFilesPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
    context: contextLines,
  });
}

/**
 * 生成给人看的 diff：带行号、只保留改动附近的上下文。
 * 同时返回新文件里第一处改动的行号，方便编辑器跳转。
 */
export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const parts = Diff.diffLines(oldContent, newContent);
  const output: string[] = [];

  const maxLineNum = Math.max(oldContent.split("\n").length, newContent.split("\n").length);
  const lineNumWidth = String(maxLineNum).length;

  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  const pushContext = (lines: string[]): void => {
    for (const line of lines) {
      output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
      oldLineNum++;
      newLineNum++;
    }
  };

  const pushEllipsis = (skipped: number): void => {
    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
    oldLineNum += skipped;
    newLineNum += skipped;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const raw = part.value.split("\n");
    if (raw[raw.length - 1] === "") {
      raw.pop();
    }

    if (part.added || part.removed) {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    // 未改动块：只在紧邻改动的地方露出几行上下文，中间大段直接折叠成 "..."。
    const nextPartIsChange = i < parts.length - 1 && Boolean(parts[i + 1].added || parts[i + 1].removed);
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextPartIsChange;

    if (hasLeadingChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        pushContext(raw);
      } else {
        pushContext(raw.slice(0, contextLines));
        pushEllipsis(raw.length - contextLines * 2);
        pushContext(raw.slice(raw.length - contextLines));
      }
    } else if (hasLeadingChange) {
      const shown = raw.slice(0, contextLines);
      pushContext(shown);
      if (raw.length - shown.length > 0) {
        pushEllipsis(raw.length - shown.length);
      }
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, raw.length - contextLines);
      if (skipped > 0) {
        pushEllipsis(skipped);
      }
      pushContext(raw.slice(skipped));
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }

    lastWasChange = false;
  }

  return { diff: output.join("\n"), firstChangedLine };
}
