import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 路径解析不做沙箱限制：相对路径基于启动目录解析，绝对路径原样使用。
// 这里额外处理 `~` 展开和「用户从别处粘贴过来的路径」的几种常见变体。

const NARROW_NO_BREAK_SPACE = "\u202F";

/**
 * 归一化用户/模型给的路径字符串：
 * - 去掉 `@file.ts` 这种引用前缀（补全 UI 里常见）
 * - 展开 `~`
 * - 去掉首尾空白与包裹的引号
 */
export function expandPath(filePath: string): string {
  let value = filePath.trim();

  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1);
  }

  if (value.startsWith("@")) {
    value = value.slice(1);
  }

  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

/** 相对 cwd 解析路径，处理 `~` 展开与绝对路径。 */
export function resolveToCwd(filePath: string, cwd: string): string {
  return path.resolve(cwd, expandPath(filePath));
}

function fileExistsSync(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// macOS 截图文件名里 AM/PM 前是窄不换行空格（U+202F），用户手打的是普通空格。
function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

// macOS 文件系统以 NFD（分解形式）存储文件名，用户输入通常是 NFC。
function tryNFDVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

// macOS 会在文件名里用弯撇号 U+2019（如 "Capture d’écran"），用户打的是直撇号。
function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

// 依次尝试各种变体，返回第一个真实存在的路径；全部失败则返回原始解析结果，
// 让上层的 ENOENT 错误照常抛出（错误信息里带的是用户能认出来的路径）。
function buildCandidates(resolved: string): string[] {
  const nfdVariant = tryNFDVariant(resolved);
  return [
    tryMacOSScreenshotPath(resolved),
    nfdVariant,
    tryCurlyQuoteVariant(resolved),
    tryCurlyQuoteVariant(nfdVariant),
  ];
}

export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (fileExistsSync(resolved)) {
    return resolved;
  }

  for (const candidate of buildCandidates(resolved)) {
    if (candidate !== resolved && fileExistsSync(candidate)) {
      return candidate;
    }
  }

  return resolved;
}

export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
  const resolved = resolveToCwd(filePath, cwd);
  if (await pathExists(resolved)) {
    return resolved;
  }

  for (const candidate of buildCandidates(resolved)) {
    if (candidate !== resolved && (await pathExists(candidate))) {
      return candidate;
    }
  }

  return resolved;
}
