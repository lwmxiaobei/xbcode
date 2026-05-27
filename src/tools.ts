import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

import { MessageBus } from "./message-bus.js";
import { TeammateManager } from "./teammate-manager.js";
import { TaskManager } from "./task-manager.js";
import { SkillLoader } from "./skills/index.js";
import { handleListMcpResources, handleMcpCall, handleReadMcpResource } from "./mcp/runtime.js";
import { describeSubagentsForHumans } from "./subagents.js";
import type { ToolArgs } from "./types.js";

const execAsync = promisify(exec);
// execFile 不走 shell，把参数以数组形式传给进程，正则 pattern 里的特殊字符不会被 shell 二次解析。
const execFileAsync = promisify(execFile);
const WORKDIR = process.cwd();
export const LEAD_NAME = "lead" as const;
export const TEAM_DIR = path.join(WORKDIR, ".team");

// 技能分为全局技能和仓库本地技能，本地技能可以覆盖同名全局技能。
// 全局目录优先使用 ~/.xbcode/skills，同时兼容 Claude 的 ~/.claude/skills。
const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".xbcode", "skills");
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const LOCAL_SKILLS_DIR = path.join(WORKDIR, "skills");

// Load order: xbcode global -> claude-compatible global -> local override
export const skillLoader = new SkillLoader([GLOBAL_SKILLS_DIR, CLAUDE_SKILLS_DIR, LOCAL_SKILLS_DIR]);

// 这些单例对象组成了 CLI agent 的工具运行时。
export const taskManager = new TaskManager(path.join(WORKDIR, ".tasks"));
export const messageBus = new MessageBus(TEAM_DIR);
export const teammateManager = new TeammateManager(TEAM_DIR, messageBus, LEAD_NAME);

// 路径解析（不再限制在工作区内）。
function safePath(relativePath: string): string {
  return path.resolve(WORKDIR, relativePath);
}

// child_process 的超时错误没有稳定类型，这里单独抽成守卫函数做识别。
function isExecTimeout(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "killed" in error && Boolean((error as { killed?: boolean }).killed);
}

// exec 抛出的错误对象通常附带 stdout/stderr，取出来可以保留更多诊断信息。
function toExecError(error: unknown): { stdout?: string; stderr?: string } {
  if (typeof error === "object" && error !== null) {
    return error as { stdout?: string; stderr?: string };
  }
  return {};
}

// bash 工具是最底层的兜底能力，因此要显式拦截极其危险的命令。
//
// 旧版用 `command.includes("rm -rf /")` 这种子串匹配，多个空格、前缀混淆
// 都能轻易绕过，且无法表达「rm -rf node_modules 放行 / rm -rf / 拦截」这种
// 上下文相关的策略。这里改成「先归一化空白 + 一组带原因的正则」的形式，
// 命中即返回具体原因，模型据此可以转告人类或自行调整。
type DangerousCommandPattern = {
  readonly pattern: RegExp;
  readonly reason: string;
};

// 命令分隔符或行首，作为大多数模式的左边界；防止 `pseudo` 误伤 `sudo` 之类的子串匹配。
const COMMAND_BOUNDARY = "(?:^|[\\s;&|`(])";

const DANGEROUS_COMMAND_PATTERNS: readonly DangerousCommandPattern[] = [
  // 删除根 / 系统目录 / 家目录 / 裸通配符。工作区里的 rm -rf node_modules、./dist 不命中。
  {
    pattern: new RegExp(
      `${COMMAND_BOUNDARY}rm\\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\\s+)+(?:/(?:\\s|$)|/(?:etc|usr|var|home|root|bin|sbin|opt|System|Library|private|boot|dev|proc|sys)(?:\\b|/)|~(?:\\s|/|$)|\\$HOME\\b|\\*(?:\\s|$))`,
    ),
    reason: "rm targeting root, a system directory, home, or bare wildcard",
  },
  // sudo 提权
  {
    pattern: new RegExp(`${COMMAND_BOUNDARY}sudo(?:\\s|$)`),
    reason: "sudo (privilege escalation)",
  },
  // 关机 / 重启 / 停机
  {
    pattern: new RegExp(`${COMMAND_BOUNDARY}(?:shutdown|reboot|halt|poweroff)(?:\\s|$)`),
    reason: "system power command",
  },
  // chmod 777 在根 / 家目录 / 裸通配符上。`chmod 755 script.sh`、`chmod 777 ./tmp` 不命中。
  {
    pattern: new RegExp(
      `${COMMAND_BOUNDARY}chmod\\s+(?:-R\\s+)?[0-7]?777\\s+(?:/|~|\\$HOME|\\*)`,
    ),
    reason: "chmod 777 on root, home, or wildcard",
  },
  // dd 写入物理块设备
  {
    pattern: /(?:^|[\s;&|`(])dd\s[^;&|]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)/,
    reason: "dd writing to a block device",
  },
  // 直接 `> /dev/sda` 重定向到块设备。`> /dev/null`、`> /tmp/out` 不命中。
  {
    pattern: />\s*\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)/,
    reason: "redirect into a block device",
  },
  // 文件系统格式化
  {
    pattern: new RegExp(`${COMMAND_BOUNDARY}mkfs(?:\\.[a-zA-Z0-9]+)?\\s`),
    reason: "filesystem format",
  },
  // curl/wget 直接管道到 shell，等同于无审查地执行远程脚本
  {
    pattern: /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|ksh|fish|dash)\b/,
    reason: "piping remote content into a shell",
  },
  // fork bomb
  {
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    reason: "fork bomb",
  },
  // 强制推送会覆盖共享分支历史
  {
    pattern: new RegExp(
      `${COMMAND_BOUNDARY}git\\s+push\\b[^;&|]*\\s(?:-f|--force(?:-with-lease)?)\\b`,
    ),
    reason: "git push --force (affects shared remote)",
  },
];

// 多个连续空白合并成单空格，避免 `rm -rf  /` 这种多空格写法绕过子串匹配。
// 不去掉引号 / 转义，因为那会改变命令语义。
function normalizeForDangerCheck(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

// 抽成独立纯函数是为了能直接做单元测试，而不必经过 child_process。
export function detectDangerousCommand(command: string): string | null {
  const normalized = normalizeForDangerCheck(command);
  if (!normalized) return null;
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}

// 工具输出统一截断阈值。50K 字符大约对应 12K~15K tokens，足够覆盖一次合理工具调用，
// 又不至于把上下文塞满。所有截断都走 `appendTruncationNotice`，保证模型能看到一致的提示。
const TOOL_OUTPUT_MAX_BYTES = 50_000;

// 模型不读字节数，所以截断提示用「行数」而不是「字节数」更直观。
// 格式参考 Claude Code 的 BashTool/utils.ts：在 kept 后追加 `\n\n... [N lines truncated] ...`，
// 模型流式从前往后读，看到末尾的提示行就知道内容被截断、可以选择再读 / 缩小范围。
export function appendTruncationNotice(content: string, maxBytes: number = TOOL_OUTPUT_MAX_BYTES): string {
  if (content.length <= maxBytes) return content;
  const kept = content.slice(0, maxBytes);
  // dropped 部分里的换行数 + 1 = 被截掉的行数（最后一行可能不完整也算一行）。
  const dropped = content.slice(maxBytes);
  const remainingLines = (dropped.match(/\n/g)?.length ?? 0) + 1;
  return `${kept}\n\n... [${remainingLines} lines truncated] ...`;
}

async function runBash(command: string, signal?: AbortSignal): Promise<string> {
  const dangerReason = detectDangerousCommand(command);
  if (dangerReason) {
    return `Error: Dangerous command blocked (${dangerReason})`;
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10,
      shell: process.env.SHELL,
      signal,
    });
    const combined = `${stdout}${stderr}`.trim();
    return combined ? appendTruncationNotice(combined) : "(no output)";
  } catch (error) {
    if ((error as { name?: string } | null | undefined)?.name === "AbortError" || signal?.aborted) {
      return "Error: Command aborted";
    }

    if (isExecTimeout(error)) {
      return "Error: Timeout (120s)";
    }

    const execError = toExecError(error);
    const combined = `${execError.stdout ?? ""}${execError.stderr ?? ""}`.trim();
    return combined ? appendTruncationNotice(combined) : `Error: ${String(error)}`;
  }
}

// 下面三个文件工具是最基础的工作区读写能力。
function runRead(filePath: string, limit?: number): string {
  try {
    const text = fs.readFileSync(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return appendTruncationNotice(lines.join("\n"));
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// 弯引号 / 直引号互转。
//
// 模型看不到弯引号会输出直引号，但很多文档（README、注释、字符串字面量）里
// 真实存在的是弯引号；反之亦然。空白模糊匹配会改变代码语义（Python/YAML），
// 这里只对引号这种「无歧义可逆」的字符做归一化。
const LEFT_SINGLE_CURLY_QUOTE = "‘";
const RIGHT_SINGLE_CURLY_QUOTE = "’";
const LEFT_DOUBLE_CURLY_QUOTE = "“";
const RIGHT_DOUBLE_CURLY_QUOTE = "”";

export function normalizeQuotes(input: string): string {
  return input
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

// 给定文件内容和模型给的 oldText，返回真正能用于替换的、来自文件的实际子串。
// 失败则返回 null。命中规则只有两条：精确匹配 → 引号归一化匹配。
export function findActualOldText(content: string, oldText: string): string | null {
  if (content.includes(oldText)) return oldText;
  const normalizedContent = normalizeQuotes(content);
  const normalizedOld = normalizeQuotes(oldText);
  const idx = normalizedContent.indexOf(normalizedOld);
  if (idx === -1) return null;
  // 归一化是字符级一一替换，长度不变，所以可以按相同偏移和长度从原文中切片。
  return content.substring(idx, idx + oldText.length);
}

// 去掉每行末尾的水平空白，但保留行尾的 \r? \n。
// markdown 的双空格行尾 = 硬换行，剥掉会改变渲染结果，因此 .md/.mdx 文件不调用这个函数。
export function stripTrailingWhitespacePerLine(input: string): string {
  return input.replace(/[ \t]+(\r?\n|$)/g, "$1");
}

function isMarkdownFile(filePath: string): boolean {
  return /\.(md|mdx)$/i.test(filePath);
}

function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf8");

    const actualOldText = findActualOldText(content, oldText);
    if (actualOldText === null) {
      return `Error: String not found in ${filePath}. Read the file again to confirm exact content.`;
    }

    const normalizedNewText = isMarkdownFile(filePath)
      ? newText
      : stripTrailingWhitespacePerLine(newText);

    // 用回调形式的 replace 避免 $&、$1 等替换序列被解释成捕获组。
    const updated = content.replace(actualOldText, () => normalizedNewText);
    if (updated === content) {
      return `Error: Edit produced no changes in ${filePath}. old_text and new_text appear to match the same content.`;
    }

    fs.writeFileSync(fullPath, updated, "utf8");
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// --- web_fetch ---------------------------------------------------------------
// MVP 版：拉取 URL -> 粗糙把 HTML 脱成文本 -> 按字符数截断。
// 对齐 Claude Code WebFetch 的几条硬约束（URL 合法性、http→https 升级、10MB body、30s 超时），
// 但不做二次总结、缓存、手动重定向防护等更重的事情。想升级再加。

// 只做最基本的 URL 校验：协议白名单、长度、禁止携带账号密码、禁止明显的内网/非公共域名。
// 所有更复杂的安全策略（domain blocklist、IP 范围校验）留给后续版本。
export function validateFetchUrl(input: string): URL {
  if (input.length > 2000) throw new Error("URL too long (>2000 chars)");
  const url = new URL(input); // URL 构造函数会在格式非法时抛错
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URL must not contain credentials");
  }
  // hostname 至少两段，过滤掉 'localhost' 这种内网名（127.0.0.1 有四段不受影响）。
  const parts = url.hostname.split(".");
  if (parts.length < 2 || parts.some((p) => p === "")) {
    throw new Error("Hostname must be a publicly resolvable domain");
  }
  // http -> https 自动升级，减少明文流量。
  if (url.protocol === "http:") url.protocol = "https:";
  return url;
}

// 常见命名 HTML 实体映射。数字/十六进制实体通过正则单独处理。
const HTML_NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

// 粗糙 HTML -> 文本转换。没有引入 turndown / cheerio 等依赖，
// 只是尽量保留段落感 + 去掉脚本样式 + 还原常见实体。
// 够模型读懂文档类页面，但不保证结构复杂的页面能还原出理想 markdown。
export function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  // 块级标签边界转换成换行，保留阅读节奏。
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|tr|h[1-6]|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  // 解实体：先处理命名实体，再处理 &#123; 和 &#x1F;。
  text = text.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (m) => HTML_NAMED_ENTITIES[m] ?? m);
  text = text.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
    const code = parseInt(n, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : "";
  });
  // 折叠多余空白：水平空白合并为单空格，连续空行最多两行。
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const WEB_FETCH_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_BODY_BYTES = 10 * 1024 * 1024;
const WEB_FETCH_MAX_OUTPUT_CHARS = 100_000;

async function runWebFetch(rawUrl: string, signal?: AbortSignal): Promise<string> {
  let url: URL;
  try {
    url = validateFetchUrl(rawUrl);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }

  // Node 自带 fetch 没有内建超时，用 AbortController 加一个 30s 硬上限。
  // 上层已经传入 signal 时通过 AbortSignal.any 合并，这样任一触发都会中断请求。
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), WEB_FETCH_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      signal: combinedSignal,
      redirect: "follow",
      headers: {
        "user-agent": "code-agent-web-fetch/1.0",
        accept: "text/html, text/markdown, text/plain, */*",
      },
    });
  } catch (error) {
    clearTimeout(timer);
    if (signal?.aborted) return "Error: Aborted";
    if (timeoutController.signal.aborted) return `Error: Timeout (${WEB_FETCH_TIMEOUT_MS / 1000}s)`;
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  clearTimeout(timer);

  if (!response.ok) {
    return `Error: HTTP ${response.status} ${response.statusText || ""}`.trim();
  }

  const contentType = response.headers.get("content-type") ?? "";
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    return `Error: failed to read body: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (Buffer.byteLength(bodyText, "utf8") > WEB_FETCH_MAX_BODY_BYTES) {
    return `Error: response body exceeds ${WEB_FETCH_MAX_BODY_BYTES / (1024 * 1024)}MB limit`;
  }

  // 粗判 HTML：要么 content-type 明确，要么开头有 <html>/<!doctype>。
  // 非 HTML 内容（JSON、纯文本、markdown）原样返回，避免误伤结构化数据。
  const looksLikeHtml = contentType.includes("text/html") || /^\s*<!doctype html|^\s*<html[\s>]/i.test(bodyText);
  const content = looksLikeHtml ? stripHtml(bodyText) : bodyText;

  const body = appendTruncationNotice(content, WEB_FETCH_MAX_OUTPUT_CHARS);
  const header = [
    `URL: ${response.url || url.toString()}`,
    `Status: ${response.status}`,
    `Content-Type: ${contentType || "unknown"}`,
    `Bytes: ${Buffer.byteLength(bodyText, "utf8")}`,
  ].join("\n");
  return `${header}\n---\n${body}`;
}

// ripgrep 不存在或被中断时统一归一化成可读的错误字符串，避免把 Node 的 Error 原样塞回模型。
// execFile 失败时的错误对象同时可能带 ErrnoException 的 "ENOENT" 字符串 code 和进程退出的数字 code，
// 为了一个守卫里都能处理，这里故意用宽松类型。
type RgExecError = Error & {
  code?: number | string;
  stdout?: string;
  stderr?: string;
};

function describeRgFailure(error: unknown, signal?: AbortSignal): string | null {
  const err = error as RgExecError;
  if (err?.code === "ENOENT") {
    return "Error: ripgrep (rg) is not installed. Install via `brew install ripgrep` or fall back to bash grep/find.";
  }
  if (signal?.aborted || err?.name === "AbortError") {
    return "Error: Aborted";
  }
  return null;
}

// glob 工具：用 `rg --files --glob <pattern>` 列出匹配文件，再按 mtime 倒序截断到 100 条。
// 选择 rg 而不是 Node 自己遍历，是因为 rg 尊重 .gitignore，并且在大仓库里快一个数量级。
async function runGlob(pattern: string, relPath: string | undefined, signal?: AbortSignal): Promise<string> {
  const searchDir = relPath ? safePath(relPath) : WORKDIR;
  const args = [
    "--files",
    "--glob",
    pattern,
    // 排除典型噪音目录；用户真需要时可以显式在 pattern 里覆盖。
    "--glob",
    "!.git",
    "--glob",
    "!node_modules",
  ];
  let files: string[] = [];
  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: searchDir,
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    files = stdout.split("\n").filter(Boolean);
  } catch (error) {
    const friendly = describeRgFailure(error, signal);
    if (friendly) return friendly;
    const err = error as RgExecError;
    // rg exit code 1 表示「没有匹配」，不是错误。
    if (err.code === 1) {
      files = (err.stdout ?? "").split("\n").filter(Boolean);
    } else {
      return `Error: ${err.message ?? String(err)}`;
    }
  }
  if (files.length === 0) return "No files found";

  // 按 mtime 倒排，最近改过的文件最有可能是用户关心的目标。
  const stats = await Promise.all(
    files.map(async (rel) => {
      try {
        const st = await fs.promises.stat(path.join(searchDir, rel));
        return { rel, mtime: st.mtimeMs };
      } catch {
        return { rel, mtime: 0 };
      }
    }),
  );
  stats.sort((a, b) => b.mtime - a.mtime);

  const LIMIT = 100;
  const kept = stats.slice(0, LIMIT).map((x) => x.rel);
  const truncated = stats.length > LIMIT;
  const lines = [
    ...kept,
    ...(truncated ? [`(Results truncated to first ${LIMIT} of ${stats.length} matches. Narrow the pattern.)`] : []),
  ];
  return lines.join("\n");
}

// grep 工具：把结构化参数翻译成 ripgrep flags，再对 stdout 做 head_limit 截断。
// 这里只暴露最常用的一组开关，复杂检索仍可通过 bash 里手写 rg 完成。
async function runGrep(args: ToolArgs, signal?: AbortSignal): Promise<string> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) return "Error: pattern is required";

  const outputMode = (args.output_mode as string | undefined) ?? "files_with_matches";
  const rgArgs: string[] = [];

  if (outputMode === "files_with_matches") rgArgs.push("--files-with-matches");
  else if (outputMode === "count") rgArgs.push("--count");
  // content 模式走 rg 默认输出，加 -n 显示行号。

  if (args.case_insensitive === true) rgArgs.push("-i");
  if (args.multiline === true) rgArgs.push("-U", "--multiline-dotall");

  if (outputMode === "content") {
    rgArgs.push("-n");
    if (typeof args.context === "number" && args.context > 0) {
      rgArgs.push("-C", String(args.context));
    }
  }
  if (typeof args.glob === "string") rgArgs.push("--glob", args.glob);
  if (typeof args.type === "string") rgArgs.push("--type", args.type);

  // 排除 VCS / 依赖目录，避免噪音。和 Claude Code GrepTool 保持一致。
  for (const d of [".git", ".svn", ".hg", ".bzr", ".jj", ".sl", "node_modules"]) {
    rgArgs.push("--glob", `!${d}`);
  }

  // `--` 明确 pattern 的边界，防止以 `-` 开头的正则被当作 flag。
  rgArgs.push("--", pattern);

  let searchPath: string | undefined;
  if (typeof args.path === "string") {
    searchPath = safePath(args.path);
    rgArgs.push(searchPath);
  }

  let stdout = "";
  try {
    const result = await execFileAsync("rg", rgArgs, {
      cwd: WORKDIR,
      maxBuffer: 20 * 1024 * 1024,
      signal,
    });
    stdout = result.stdout;
  } catch (error) {
    const friendly = describeRgFailure(error, signal);
    if (friendly) return friendly;
    const err = error as RgExecError;
    if (err.code === 1) {
      stdout = err.stdout ?? ""; // 没命中
    } else {
      return `Error: ${err.message ?? String(err)}`;
    }
  }

  if (!stdout.trim()) return "No matches found";

  // head_limit: 默认 250 行，0 表示不限制。
  const headLimit = typeof args.head_limit === "number" ? args.head_limit : 250;
  const lines = stdout.split("\n");
  // rg 输出末尾通常有空行，去掉免得占配额。
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  if (headLimit === 0) return stdout.slice(0, 500_000);

  const total = lines.length;
  const kept = lines.slice(0, headLimit);
  if (total <= headLimit) return kept.join("\n");
  return `${kept.join("\n")}\n(Output truncated to first ${headLimit} of ${total} lines. Pass head_limit=0 to disable.)`;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// BASE_TOOLS 是所有 agent 都共享的最小工具集合。
// MCP 的 resource/prompt 仍通过 `mcp_call` 访问；tool 会在运行时动态展开成独立 function tool。
export const BASE_TOOLS = [
  {
    type: "function",
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_file",
    description: "Read file contents.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Write content to file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "Replace exact text in file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "glob",
    description:
      "Find files by glob pattern (powered by ripgrep). Returns up to 100 paths sorted by modification time (newest first). Prefer this over `bash find` or `ls`: respects .gitignore, consistent output, truncation built in.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. '**/*.ts', 'src/**/*.tsx', '*.json'.",
        },
        path: {
          type: "string",
          description: "Directory to search in (relative to workspace). Omit to search the whole workspace.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "grep",
    description:
      "Search file contents with ripgrep (full regex, .gitignore-aware). Prefer this over `bash grep`: the output is capped (default 250 lines) so your context cannot be flooded. For open-ended multi-round exploration, dispatch the `task` tool with the explore subagent instead.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern (ripgrep syntax). Literal braces need escaping: use '\\{\\}' to match '{}'.",
        },
        path: {
          type: "string",
          description: "File or directory to search in. Omit to search the whole workspace.",
        },
        glob: {
          type: "string",
          description: "Glob filter, e.g. '*.ts', '*.{js,tsx}'.",
        },
        type: {
          type: "string",
          description: "File type shortcut, e.g. 'js', 'py', 'rust'. More efficient than `glob` for standard types.",
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: "Default 'files_with_matches'. Use 'content' to see matching lines, 'count' for per-file match counts.",
        },
        case_insensitive: {
          type: "boolean",
          description: "Case-insensitive match (rg -i).",
        },
        context: {
          type: "integer",
          description: "Lines of context before and after each match. Only applied when output_mode='content'.",
        },
        head_limit: {
          type: "integer",
          description: "Max output lines. Defaults to 250. Pass 0 to disable the cap (use sparingly).",
        },
        multiline: {
          type: "boolean",
          description: "Enable multiline matching (rg -U --multiline-dotall).",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_create",
    description: "Create a new task. Returns the created task as JSON.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short title of the task" },
        description: { type: "string", description: "Detailed description (optional)" },
        owner: { type: "string", description: "Task creator or owner. Defaults to lead." },
        assignee: { type: "string", description: "Optional teammate assigned to this task." },
      },
      required: ["subject"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_update",
    description:
      "Update a task's status, assignment, summary, blocked reason, or dependencies. When a task is marked completed, all tasks blocked by it are automatically unblocked.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the task to update" },
        status: { type: "string", enum: ["pending", "assigned", "in_progress", "blocked", "completed", "failed"] },
        blocked_by: {
          type: "array",
          items: { type: "integer" },
          description: "Task IDs that this task depends on (add to existing)",
        },
        blocks: {
          type: "array",
          items: { type: "integer" },
          description: "Task IDs that depend on this task (add to existing)",
        },
        assignee: { type: "string", description: "Teammate assigned to this task." },
        result_summary: { type: "string", description: "Summary of the task result." },
        blocked_reason: { type: "string", description: "Reason the task is blocked." },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_assign",
    description: "Assign a task to a teammate, notify them, and wake their runtime.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the task to assign" },
        assignee: { type: "string", description: "Teammate assigned to this task." },
      },
      required: ["task_id", "assignee"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_complete",
    description: "Mark a task completed with a result summary and emit a structured completion event.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the task to complete" },
        result_summary: { type: "string", description: "Summary of the completed task result." },
      },
      required: ["task_id", "result_summary"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_block",
    description: "Mark a task blocked with a reason and emit a structured blocked event.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the blocked task" },
        reason: { type: "string", description: "Reason the task is blocked." },
      },
      required: ["task_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_fail",
    description: "Mark a task failed and emit a structured failure event.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the failed task" },
        reason: { type: "string", description: "Reason the task failed." },
      },
      required: ["task_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_list",
    description: "List all tasks with their status and dependencies.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_get",
    description: "Get full details of a single task by ID.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the task" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "list_mcp_resources",
    description: "List cached MCP resources for one server or for all configured servers.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Optional MCP server name. Omit to list resources across all servers." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_mcp_resource",
    description: "Read a cached MCP resource by exact server name and resource URI.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Configured MCP server name" },
        uri: { type: "string", description: "Exact resource URI from list_mcp_resources" },
      },
      required: ["server", "uri"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "mcp_call",
    description:
      "Get a configured MCP prompt by exact server name and prompt name. Do not use this for MCP tools or resources.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Configured MCP server name" },
        kind: { type: "string", enum: ["prompt"] },
        name: { type: "string", description: "Prompt name" },
        arguments: {
          type: "object",
          description: "Arguments for the prompt",
          additionalProperties: true,
        },
      },
      required: ["server", "kind"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "load_skill",
    description: "Load specialized knowledge by name. Use this to access domain-specific guidance before tackling unfamiliar topics.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
        args: { type: "string", description: "Optional arguments or scope for the skill" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "web_fetch",
    description:
      "Fetch the content of a web page. Automatically upgrades HTTP to HTTPS, strips HTML tags to plain text, and truncates the output if it exceeds limits. Use this to read documentation or reference pages online.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The absolute URL to fetch, e.g. 'https://example.com/docs'.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
] as const;

// `task` 是主 agent 独有的能力，用于派生一次性子代理，不下放给 teammate。
export const TASK_TOOL = {
  type: "function",
  name: "task",
  description:
    `Dispatch a subtask to an independent sub-agent with a clean context. Returns only the sub-agent's final summary.
Available subagent types:
${describeSubagentsForHumans()}`,
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A clear, self-contained description of the task for the sub-agent to perform.",
      },
      subagent_type: {
        type: "string",
        enum: ["general-purpose", "explore"],
        description: "Optional specialized sub-agent type. Omit to use general-purpose.",
      },
    },
    required: ["description"],
    additionalProperties: false,
  },
} as const;

// 团队协作消息工具。P1 阶段只保留最小字段：to + content。
// 协议消息（shutdown / approval）将在 P3 用独立工具实现，不再混在 message_send 里。
export const TEAM_MESSAGE_TOOL = {
  type: "function",
  name: "message_send",
  description: "Send an asynchronous message to lead or another teammate.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "Target teammate name or 'lead'" },
      content: { type: "string", description: "Message body" },
    },
    required: ["to", "content"],
    additionalProperties: false,
  },
} as const;

export const TEAMMATE_SPAWN_TOOL = {
  type: "function",
  name: "teammate_spawn",
  description: "Create a persistent teammate with its own inbox and runtime.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Stable teammate name, for example alice" },
      role: { type: "string", description: "Teammate role or specialty" },
      prompt: { type: "string", description: "Initial task to deliver to the new teammate" },
    },
    required: ["name", "role", "prompt"],
    additionalProperties: false,
  },
} as const;

export const TEAMMATE_LIST_TOOL = {
  type: "function",
  name: "teammate_list",
  description: "List current teammates and their statuses.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export const TEAMMATE_SHUTDOWN_TOOL = {
  type: "function",
  name: "teammate_shutdown",
  description: "Request a graceful shutdown for one teammate or all teammates.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Teammate name. Omit to stop all teammates." },
    },
    additionalProperties: false,
  },
} as const;

// 主 agent 可以看到全部工具：基础工具 + 子任务 + 团队协作。
// P1 删除 LEAD_INBOX_TOOL：lead 邮箱由 runOneTurn 自动注入，不再需要 lead 主动「查邮箱」。
export const TOOLS = [
  ...BASE_TOOLS,
  TASK_TOOL,
  TEAM_MESSAGE_TOOL,
  TEAMMATE_SPAWN_TOOL,
  TEAMMATE_LIST_TOOL,
  TEAMMATE_SHUTDOWN_TOOL,
] as const;

// teammate 只能使用基础工具和消息发送，避免无限扩张权限。
export const TEAMMATE_TOOLS = [
  ...BASE_TOOLS,
  TEAM_MESSAGE_TOOL,
] as const;

// Chat Completions API 需要另一种 tool 结构，这里把内部定义转换成兼容格式。
function toChatTools<T extends readonly { name: string; description: string; parameters: unknown }[]>(tools: T) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

export const CHAT_TOOLS = toChatTools(TOOLS);
export const TEAMMATE_CHAT_TOOLS = toChatTools(TEAMMATE_TOOLS);
export const BASE_CHAT_TOOLS = toChatTools(BASE_TOOLS);

// 这里是“工具名 -> 实际执行函数”的路由表。
// `mcp_call` 在这一层接入到 MCP runtime，由后者继续完成初始化、校验和分发。
export const BASE_TOOL_HANDLERS: Record<string, (args: ToolArgs, control?: { signal?: AbortSignal }) => Promise<string> | string> = {
  bash: ({ command }, control) => runBash(String(command), control?.signal),
  read_file: ({ path: filePath, limit }) => runRead(String(filePath), toOptionalNumber(limit)),
  write_file: ({ path: filePath, content }) => runWrite(String(filePath), String(content)),
  edit_file: ({ path: filePath, old_text, new_text }) => runEdit(String(filePath), String(old_text), String(new_text)),
  glob: ({ pattern, path: p }, control) => runGlob(String(pattern), toOptionalString(p), control?.signal),
  grep: (args, control) => runGrep(args, control?.signal),
  list_mcp_resources: (args) => handleListMcpResources(args),
  read_mcp_resource: (args) => handleReadMcpResource(args),
  mcp_call: (args) => handleMcpCall(args),
  task_create: async ({ subject, description, owner, assignee }) =>
    await taskManager.create(
      String(subject),
      toOptionalString(description),
      toOptionalString(owner) ?? LEAD_NAME,
      toOptionalString(assignee),
    ),
  task_update: async ({ task_id, status, blocked_by, blocks, assignee, result_summary, blocked_reason }) =>
    await taskManager.update(
      Number(task_id),
      toOptionalString(status),
      blocked_by as number[] | undefined,
      blocks as number[] | undefined,
      toOptionalString(assignee),
      toOptionalString(result_summary),
      toOptionalString(blocked_reason),
    ),
  task_assign: async ({ task_id, assignee }) => {
    const task = await taskManager.getTask(Number(task_id));
    if (!task) {
      return `Error: Task ${Number(task_id)} not found.`;
    }

    const normalizedAssignee = String(assignee ?? "").trim();
    if (!normalizedAssignee) {
      return "Error: assignee is required.";
    }

    const updated = await taskManager.update(task.id, "assigned", undefined, undefined, normalizedAssignee);
    // P1：保留「lead 把任务通知到 assignee」的真实消息，简化为只 from/to/content。
    // 任务详情拼到 content 里方便 assignee 直接看到，不再依赖 payload 字段。
    // task_started 回执在此处删除（属于协议事件，P3 用独立 schema 重做）。
    void messageBus.send({
      from: LEAD_NAME,
      to: normalizedAssignee,
      content: `Assigned task #${task.id}: ${task.subject}\n${task.description}`,
    });
    teammateManager.wake(normalizedAssignee);
    return updated;
  },
  task_complete: async ({ task_id, result_summary }) => {
    const task = await taskManager.getTask(Number(task_id));
    if (!task) {
      return `Error: Task ${Number(task_id)} not found.`;
    }

    // P1 阶段不再向 lead 发协议消息（task_completed）。task manager 的状态变更
    // 是 lead 通过 task_list/task_get 自查的依据；P3 协议消息阶段会用独立 schema 重做。
    const updated = await taskManager.update(task.id, "completed", undefined, undefined, undefined, String(result_summary ?? ""));
    return updated;
  },
  task_block: async ({ task_id, reason }) => {
    const task = await taskManager.getTask(Number(task_id));
    if (!task) {
      return `Error: Task ${Number(task_id)} not found.`;
    }

    // P1：同 task_complete，删除 messageBus.send；仅写入 task manager 状态。
    const text = String(reason ?? "");
    const updated = await taskManager.update(task.id, "blocked", undefined, undefined, undefined, undefined, text);
    return updated;
  },
  task_fail: async ({ task_id, reason }) => {
    const task = await taskManager.getTask(Number(task_id));
    if (!task) {
      return `Error: Task ${Number(task_id)} not found.`;
    }

    // P1：同 task_complete，删除 messageBus.send；仅写入 task manager 状态。
    const text = String(reason ?? "");
    const updated = await taskManager.update(task.id, "failed", undefined, undefined, undefined, text);
    return updated;
  },
  task_list: async () => await taskManager.list(),
  task_get: async ({ task_id }) => await taskManager.get(Number(task_id)),
  load_skill: ({ name, args }) => skillLoader.renderSkill(String(name), toOptionalString(args)),
  // P1：teammate_list handler 异步化。formatTeamStatus 在 T6 改成 async。
  teammate_list: async () => await teammateManager.formatTeamStatus(),
  web_fetch: ({ url }, control) => runWebFetch(String(url), control?.signal),
};
