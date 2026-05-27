#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import fs from "node:fs";
import { Box, Newline, Static, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import OpenAI from "openai";
import { useEffect, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";

import pkg from "../package.json" with { type: "json" };

import { isTurnInterruptedError, runAgentTurn, type AgentConfig } from "./agent.js";
import { extractImagePathsFromText, importClipboardImageMacos } from "./clipboard-image.js";
// P1：删除 supervisor.ts（processLeadInboxEvents 依赖的 eventType/taskId 协议字段已移除）。
// P3 协议消息阶段会用独立机制重做事件处理，不再混在 lead 邮箱消费流程里。
import {
  clearProviderCredentials,
  getCredentialsPath,
  getProviderModels,
  getProviderNames,
  getSettingsPath,
  loadCredentialsFile,
  loadSettings,
  needsModelSelection,
  normalizeModelEntry,
  reloadSettings,
  resolveConfig,
  resolveProviderAuthState,
  resolveRuntimeAuth,
  writeCredentialsFile,
  updateProviderModels,
  type ProviderAuthState,
  type ResolvedConfig,
  type StoredOAuthCredentials,
} from "./config.js";
import { estimateTokens, autoCompact, autoCompactResponseHistory } from "./compact.js";
import { createSharedFetch } from "./http.js";
import { normalizeCommand, parseStartupCommand, submissionNeedsSelectedModel } from "./commands.js";
import { createSubmitDeduper, getSubmittedValueFromInput } from "./input-submit.js";
import { formatTeammateMessages } from "./message-bus.js";
import { ensureMcpInitialized, getMcpPromptInstructions, mcpManager, primeMcpRuntime, refreshMcpFromSettings } from "./mcp/runtime.js";
import {
  OPENAI_CODEX_BASE_URL,
  createOpenAIOAuthFetch,
  getOpenAIOAuthDefaultHeaders,
  listAvailableModels,
  refreshAccessToken,
  startOpenAILogin,
} from "./oauth/openai.js";
import { buildSystemPrompt } from "./prompt.js";
import { appendSessionCheckpoint, createSessionId, listRecentSessions, loadSession, type SessionSnapshot } from "./session-store.js";
import { skillLoader, messageBus, taskManager, teammateManager } from "./tools.js";
import { formatBusyStatus } from "./busy-status.js";
import type { AgentState, DiffLine, ImageAttachment, PersistedUiMessage, ToolApprovalDecision, ToolArgs, TokenUsage, UiBridge, UiMessage } from "./types.js";
import { fetchOpenAIUsage, formatUsageReport, UsageRequestError } from "./usage.js";
import { ellipsize } from "./utils.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
loadDotenv({ path: path.join(PROJECT_ROOT, ".env"), override: true });

const WORKDIR = process.cwd();

function createAgentConfig(resolved: ResolvedConfig, authState?: ProviderAuthState): AgentConfig {
  const bearerToken = authState?.bearerToken || resolved.apiKey || undefined;
  const isOpenAIOAuth = resolved.providerName === "openai" && authState?.authMode === "oauth" && authState.oauth;
  /**
   * OpenAI OAuth tokens issued by the Codex login flow do not carry the public
   * API scopes required by `api.openai.com/v1/responses`. They are instead meant
   * for ChatGPT's internal Codex backend, so OAuth sessions must use that base
   * URL and header set while API-key sessions keep using the public OpenAI API.
   */
  const clientOptions = isOpenAIOAuth
    ? {
        apiKey: bearerToken,
        baseURL: OPENAI_CODEX_BASE_URL,
        defaultHeaders: getOpenAIOAuthDefaultHeaders(authState.oauth as StoredOAuthCredentials),
        fetch: createOpenAIOAuthFetch(),
      }
    : {
        apiKey: bearerToken,
        baseURL: resolved.baseURL !== "https://api.openai.com/v1" ? resolved.baseURL : undefined,
        // 共享 dispatcher 把闲置 keep-alive 连接保留时间压到 1s，避免在多轮工具
        // 执行的间隔后下一轮 stream 拿到一条已被远端关闭的连接、立刻报 `terminated`。
        fetch: createSharedFetch(),
      };
  const client = new OpenAI(clientOptions);
  return {
    client,
    model: resolved.model,
    system: buildSystemPrompt({
      workdir: WORKDIR,
      skillDescriptions: skillLoader.getDescriptions(),
      mcpInstructions: getMcpPromptInstructions(),
    }),
    showThinking: resolved.showThinking,
    apiMode: resolved.apiMode,
    // ChatGPT Codex backend rejects `previous_response_id`, so only this
    // OAuth-backed branch needs stateless replay. All other providers keep the
    // original server-side Responses chaining behavior.
    supportsPreviousResponseId: !isOpenAIOAuth,
  };
}

// Initialized lazily after user selects model (or immediately if MODEL_ID env var is set)
let currentResolved: ResolvedConfig = undefined!;
let agentConfig: AgentConfig = undefined!;
let currentAuthState: ProviderAuthState | undefined;

function ensureConfig(providerName?: string, modelName?: string): void {
  currentResolved = resolveConfig(providerName, modelName);
  currentAuthState = resolveProviderAuthState(loadSettings(), currentResolved.providerName, loadCredentialsFile(getCredentialsPath()));
  agentConfig = createAgentConfig(currentResolved, currentAuthState);
  primeMcpRuntime();
}

async function refreshCurrentAuth(): Promise<void> {
  if (!currentResolved) {
    return;
  }

  const settings = loadSettings();
  const result = await resolveRuntimeAuth({
    settings,
    providerName: currentResolved.providerName,
    credentials: loadCredentialsFile(getCredentialsPath()),
    refreshOAuthToken: async (credentials) => await refreshAccessToken({
      clientId: credentials.client_id,
      refreshToken: credentials.refresh_token ?? "",
    }),
    onCredentialsUpdated: async (credentials) => {
      await writeCredentialsFile(getCredentialsPath(), credentials);
    },
  });

  currentAuthState = result.state;
  agentConfig = createAgentConfig(currentResolved, currentAuthState);
}

// Initialize immediately when startup can resolve a usable model without prompting.
if (!needsModelSelection()) {
  ensureConfig();
}

export type ModelChoice = {
  provider: string;
  modelId: string;
  displayName: string;
  description: string;
};

/** Build a flat list of model choices from all providers */
function buildModelChoices(): ModelChoice[] {
  const settings = loadSettings();
  const choices: ModelChoice[] = [];
  for (const [providerName, profile] of Object.entries(settings.providers)) {
    for (const entry of profile.models) {
      const normalized = normalizeModelEntry(entry);
      choices.push({
        provider: providerName,
        modelId: normalized.id,
        displayName: normalized.name || normalized.id,
        description: normalized.description || "",
      });
    }
  }
  return choices;
}

type TrustPromptProps = Readonly<{ selectedIndex: number }>;
type StringRef = { current: string | undefined };
type ViewportRow = {
  id: string;
  prefix: string;
  prefixColor?: string;
  text: string;
  color?: string;
  dimColor?: boolean;
};
type SlashCommand = {
  command: string;
  description: string;
};

type SkillSlashInvocation = {
  command: string;
  args?: string;
};

type StartupResumeState = {
  snapshot?: SessionSnapshot;
  startupMessage?: UiMessage;
  hasResolvedModel: boolean;
};

/**
 * Estimate the active conversation footprint for the current API mode.
 *
 * Why this exists:
 * - `chat-completions` keeps its full transcript in `chatHistory`, while the
 *   Codex OAuth fallback now keeps replayable Responses items in
 *   `responseHistory`.
 * - Reusing one helper keeps status and debug output honest without changing
 *   how other providers account for context.
 * - The estimate remains intentionally rough; it only needs to show whether
 *   context is growing, not provide billing-grade numbers.
 */
function estimateActiveContextTokens(state: AgentState): number {
  if (currentResolved?.apiMode === "responses") {
    return estimateTokens(state.responseHistory as any);
  }
  return estimateTokens(state.chatHistory);
}

const MAX_VISIBLE_SLASH_MATCHES = 8;

const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/help", description: "show available commands" },
  { command: "/status", description: "show session status" },
  { command: "/usage", description: "show codex subscription usage (5h / weekly limits)" },
  { command: "/login", description: "start oauth login for the current provider" },
  { command: "/logout", description: "clear oauth credentials for the current provider" },
  { command: "/mcp", description: "show MCP server status" },
  { command: "/mcp refresh", description: "refresh MCP caches and reconnect servers" },
  { command: "/team", description: "show teammate statuses" },
  { command: "/tasks", description: "show task board" },
  { command: "/task", description: "show task details by id" },
  { command: "/inbox", description: "drain lead inbox" },
  { command: "/provider", description: "switch provider" },
  { command: "/model", description: "switch model within current provider" },
  { command: "/compact", description: "compact conversation history to free context space" },
  { command: "/new", description: "clear context and start a new conversation" },
  { command: "/resume", description: "list recent saved sessions or restore one by id" },
  { command: "/exit", description: "exit the CLI" },
];


function getSkillSlashCommands(): SlashCommand[] {
  const limit = 30;
  return skillLoader.getPromptCommands().map((command) => ({
    command: `/${command.name}`,
    description: command.description.length > limit
      ? `${command.description.slice(0, limit)}...`
      : command.description,
  }));
}

function getAllSlashCommands(): SlashCommand[] {
  const commands = new Map<string, SlashCommand>();

  for (const command of SLASH_COMMANDS) {
    commands.set(command.command, command);
  }

  for (const command of getSkillSlashCommands()) {
    if (!commands.has(command.command)) {
      commands.set(command.command, command);
    }
  }

  return [...commands.values()].sort((left, right) => left.command.localeCompare(right.command));
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  return `${minutes}m${remainingSeconds}s`;
}

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function toolPreview(value: string, maxLength = 400): string {
  return ellipsize(value.replaceAll(/\s+/g, " ").trim(), maxLength);
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

type ToolDisplay = {
  title: string;
  subtitle?: string;
  lines: { text: string; color: string; prefix?: string }[];
};

function formatEditFileDiff(args: Record<string, unknown>): ToolDisplay {
  const filePath = String(args.path ?? "");
  const oldText = String(args.old_text ?? "");
  const newText = String(args.new_text ?? "");

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const added = newLines.length;
  const removed = oldLines.length;

  const parts: string[] = [];
  if (added > 0) parts.push(`Added ${added} line${added > 1 ? "s" : ""}`);
  if (removed > 0) parts.push(`removed ${removed} line${removed > 1 ? "s" : ""}`);
  const subtitle = parts.length > 0 ? parts.join(", ") : undefined;

  const CONTEXT = 3;
  const lines: ToolDisplay["lines"] = [];

  // Try to read the file to get line numbers and context
  let fileLines: string[] | null = null;
  let matchLine = -1;
  try {
    const fullPath = path.resolve(WORKDIR, filePath);
    const content = fs.readFileSync(fullPath, "utf8");
    fileLines = content.split("\n");
    // Find where new_text starts in the edited file
    const idx = content.indexOf(newText);
    if (idx >= 0) {
      matchLine = content.slice(0, idx).split("\n").length - 1;
    }
  } catch {
    // File might not exist or be readable; fall back to no-context view
  }

  if (fileLines && matchLine >= 0) {
    // Show context before
    const contextStart = Math.max(0, matchLine - CONTEXT);
    for (let i = contextStart; i < matchLine; i++) {
      lines.push({ text: `  ${String(i + 1).padStart(4)}  ${fileLines[i]}`, color: "gray" });
    }
    // Show removed lines
    for (let i = 0; i < oldLines.length; i++) {
      const lineNum = matchLine + i;
      lines.push({ text: `- ${String(lineNum + 1).padStart(4)}  ${oldLines[i]}`, color: "red" });
    }
    // Show added lines
    for (let i = 0; i < newLines.length; i++) {
      const lineNum = matchLine + i;
      lines.push({ text: `+ ${String(lineNum + 1).padStart(4)}  ${newLines[i]}`, color: "green" });
    }
    // Show context after
    const afterStart = matchLine + newLines.length;
    const afterEnd = Math.min(fileLines.length, afterStart + CONTEXT);
    for (let i = afterStart; i < afterEnd; i++) {
      lines.push({ text: `  ${String(i + 1).padStart(4)}  ${fileLines[i]}`, color: "gray" });
    }
  } else {
    // Fallback: no context
    for (const line of oldLines) {
      lines.push({ text: `- ${line}`, color: "red" });
    }
    for (const line of newLines) {
      lines.push({ text: `+ ${line}`, color: "green" });
    }
  }

  return { title: `Update(${filePath})`, subtitle, lines };
}

function formatWriteFile(args: Record<string, unknown>, result: string): ToolDisplay {
  const filePath = String(args.path ?? "");
  const content = String(args.content ?? "");
  const contentLines = content.split("\n");
  const totalLines = contentLines.length;
  const previewCount = Math.min(10, totalLines);

  const lines: ToolDisplay["lines"] = [];
  for (let i = 0; i < previewCount; i++) {
    lines.push({ text: `  ${String(i + 1).padStart(4)}  ${contentLines[i]}`, color: "green" });
  }
  if (totalLines > previewCount) {
    lines.push({ text: `  ... (${totalLines - previewCount} more lines)`, color: "gray" });
  }

  return {
    title: `Write(${filePath})`,
    subtitle: result,
    lines,
  };
}

function formatBash(args: Record<string, unknown>, result: string): ToolDisplay {
  const command = String(args.command ?? "");
  const lines: ToolDisplay["lines"] = [];

  const resultLines = result.split("\n");
  const previewCount = Math.min(15, resultLines.length);
  for (let i = 0; i < previewCount; i++) {
    lines.push({ text: `  ${resultLines[i]}`, color: "white" });
  }
  if (resultLines.length > previewCount) {
    lines.push({ text: `  ... (${resultLines.length - previewCount} more lines)`, color: "gray" });
  }

  return {
    title: `Bash(${ellipsize(command, 60)})`,
    lines,
  };
}

function formatToolDisplay(name: string, args: Record<string, unknown>, result: string): ToolDisplay | null {
  // A rejected call did not run, so skip the rich diff/command view (which would
  // otherwise look as if it had been applied) and fall back to plain text.
  if (result.startsWith("Rejected by user:")) {
    return null;
  }
  switch (name) {
    case "edit_file":
      return result.startsWith("Error") ? null : formatEditFileDiff(args);
    case "write_file":
      return result.startsWith("Error") ? null : formatWriteFile(args, result);
    case "bash":
      return formatBash(args, result);
    default:
      return null;
  }
}

// One-line-per-entry summary of what a tool call will do, shown in the approval
// prompt so the user can decide without inspecting raw JSON args.
function summarizeApprovalTarget(name: string, args: Record<string, unknown>): string[] {
  switch (name) {
    case "bash":
      return String(args.command ?? "").split("\n").slice(0, 8);
    case "write_file":
      return [`write → ${String(args.path ?? "")}`];
    case "edit_file":
      return [`edit → ${String(args.path ?? "")}`];
    default:
      return [toolPreview(JSON.stringify(args))];
  }
}

type ApprovalPromptProps = Readonly<{
  name: string;
  lines: string[];
  selectedIndex: number;
  width: number;
}>;

function ApprovalPrompt({ name, lines, selectedIndex, width }: ApprovalPromptProps) {
  const options = [
    "Yes, run once",
    `Yes, and always allow ${name} this session`,
    "No, reject this call (Esc)",
  ];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow" wrap="truncate">{borderRule(width)}</Text>
      <Text bold color="yellow">Approve tool call: {name}?</Text>
      {lines.map((line, index) => (
        <Text key={index} color="gray" wrap="truncate">  {line || " "}</Text>
      ))}
      <Newline />
      {options.map((label, index) => (
        <Text key={label} color={selectedIndex === index ? "cyan" : "white"}>
          {selectedIndex === index ? "›" : " "} {index + 1}. {label}
        </Text>
      ))}
      <Text color="gray">↑/↓ to choose, Enter to confirm, Esc to reject</Text>
      <Text color="yellow" wrap="truncate">{borderRule(width)}</Text>
    </Box>
  );
}

const marked = new Marked({ async: false }, markedTerminal({ reflowText: true, showSectionPrefix: false }));

function renderMarkdown(text: string): string {
  let rendered = marked.parse(text) as string;
  // marked-terminal doesn't handle inline bold/italic inside list items — fix up leftovers
  rendered = rendered.replaceAll(/\*\*(.+?)\*\*/g, "\x1b[1m$1\x1b[22m"); // bold
  rendered = rendered.replaceAll(/\*(.+?)\*/g, "\x1b[3m$1\x1b[23m");     // italic
  return rendered.trimEnd();
}

function wrapTextToRows(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const logicalLines = text.split("\n");
  const rows: string[] = [];

  for (const logicalLine of logicalLines) {
    const wrapped = wrapAnsi(logicalLine.length > 0 ? logicalLine : " ", safeWidth, {
      hard: true,
      trim: false,
      wordWrap: false,
    }).split("\n");
    rows.push(...(wrapped.length > 0 ? wrapped : [" "]));
  }

  return rows.length > 0 ? rows : [" "];
}

function getMessageMarker(kind: UiMessage["kind"]): { symbol: string; color: string } | undefined {
  switch (kind) {
    case "user":
      return { symbol: "›", color: "cyan" };
    case "assistant":
      return { symbol: "●", color: "white" };
    default:
      return undefined;
  }
}

function borderRule(width: number): string {
  return "─".repeat(Math.max(1, width));
}

function trimToLine(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function configMessage(): UiMessage {
  return {
    id: "config",
    kind: "system",
    title: "config",
    text: `provider=${currentResolved.providerName} model=${currentResolved.model} configuredBaseURL=${currentResolved.baseURL} effectiveBaseURL=${getEffectiveBaseURL(currentResolved, currentAuthState)} apiMode=${currentResolved.apiMode}`,
  };
}

function formatAuthSummary(state?: ProviderAuthState): string {
  if (!state) {
    return "auth none";
  }
  if (state.authMode === "oauth") {
    const email = state.oauth?.email?.trim();
    if (email) {
      return `auth oauth(${email})`;
    }
    return "auth oauth";
  }
  if (state.authMode === "apiKey") {
    if (state.oauth?.refresh_token?.trim()) {
      return "auth apiKey (oauth fallback available)";
    }
    return "auth apiKey";
  }
  return "auth none";
}

/**
 * 返回当前会话真正用于请求模型的 endpoint。
 *
 * 为什么不能只看配置里的 `baseURL`：
 * - `ResolvedConfig.baseURL` 反映的是 provider 静态配置，便于用户理解和持久化，
 *   但不代表运行时一定按它发请求。
 * - OpenAI OAuth 是一个特殊分支：配置仍然指向公开 API，实际请求却会改走
 *   ChatGPT Codex backend。
 * - 统一用这个 helper 计算“生效中的 endpoint”，可以让 `/status`、调试信息
 *   和底部状态栏保持一致，避免排障时看到互相矛盾的地址。
 */
function getEffectiveBaseURL(resolved: ResolvedConfig, authState?: ProviderAuthState): string {
  const usesOpenAICodexBackend = resolved.providerName === "openai"
    && authState?.authMode === "oauth"
    && Boolean(authState.oauth);

  return usesOpenAICodexBackend ? OPENAI_CODEX_BASE_URL : resolved.baseURL;
}

/**
 * Show credential problems directly in the welcome panel because a configured
 * `defaultModel` can now bypass the selection screen entirely.
 *
 * Why this exists:
 * - Users should see the problem before the first request fails.
 * - OAuth-backed providers need a login reminder, while API-key providers need
 *   a config reminder. The fixes are different, so the warning should be too.
 */
function getProviderStartupAuthWarning(): string | null {
  if (!currentResolved || !currentAuthState || currentAuthState.authMode !== "none") {
    return null;
  }

  const settings = loadSettings();
  const provider = settings.providers[currentResolved.providerName];
  if (!provider) {
    return null;
  }

  return provider.auth?.type === "oauth" ? "未登录" : "未配置API";
}

function headerItem(): UiMessage {
  return {
    id: "header",
    kind: "system",
    text: "",
  };
}

function getMessagePalette(kind: UiMessage["kind"]): { titleColor: string; bodyColor: string } {
  switch (kind) {
    case "tool":
      return { titleColor: "yellow", bodyColor: "green" };
    case "error":
      return { titleColor: "red", bodyColor: "red" };
    case "thinking":
      return { titleColor: "blue", bodyColor: "blue" };
    case "system":
      return { titleColor: "gray", bodyColor: "white" };
    case "user":
      return { titleColor: "cyan", bodyColor: "cyan" };
    default:
      return { titleColor: "white", bodyColor: "white" };
  }
}

function WelcomePanel({ width, messages }: { width: number; messages: UiMessage[] }) {
  const contentWidth = Math.max(20, width - 4);
  const authWarning = getProviderStartupAuthWarning();

  return (
    <Box
      borderStyle="round"
      borderColor="red"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
      paddingY={0}
    >
      <Box justifyContent="space-between">
        <Text bold color="red">xbcode</Text>
        <Text color="gray">v{pkg.version}</Text>
      </Box>
      <Box marginTop={1}>
        <Box width="36%" flexDirection="column" paddingRight={2}>
          <Text bold>Welcome back{currentResolved ? ` · ${currentResolved.providerName}` : ""}</Text>
          <Text color="gray">{ellipsize(WORKDIR, contentWidth)}</Text>
          <Text> </Text>
          <Text color="red">   ▟██▙</Text>
          <Text color="red">  ▟████▙</Text>
          <Text color="red">   ▜██▛</Text>
          <Text> </Text>
          <Text color="gray">{currentResolved ? `${currentResolved.model} · ${currentResolved.apiMode}` : "No model selected"}</Text>
        </Box>
        <Box width={1}>
          <Text color="red">│</Text>
        </Box>
        <Box flexGrow={1} flexDirection="column" paddingLeft={2}>
          <Text bold color="red">Tips for getting started</Text>
          <Text>Run <Text color="whiteBright">/help</Text> to see commands, <Text color="whiteBright">/model</Text> to switch models.</Text>
          <Text>Use <Text color="whiteBright">/new</Text> to reset, or <Text color="whiteBright">/resume</Text> to reopen a saved session.</Text>
          {authWarning
            ? <Text color="red">当前 provider {authWarning}。请先配置 API，或者完成 /login。</Text>
            : null}
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Footer line shown while busy. Reads heartbeat refs that the agent loop updates
 * through `bridge.noteStreamActivity()`, and surfaces both elapsed time and
 * (when relevant) the idle gap since the last stream event.
 *
 * `busyTick` is just a re-render trigger — the actual timing comes from refs so
 * we don't churn React state once per second for every byte the model streams.
 */
function BusyStatusLine({
  busyTick,
  turnStartedAtRef,
  lastActivityAtRef,
}: {
  busyTick: number;
  turnStartedAtRef: { readonly current: number | null };
  lastActivityAtRef: { readonly current: number | null };
}) {
  // referenced so React links the prop to the render; value itself isn't used
  void busyTick;
  const now = Date.now();
  const startedAt = turnStartedAtRef.current ?? now;
  const lastActivityAt = lastActivityAtRef.current ?? startedAt;
  const elapsedSeconds = (now - startedAt) / 1000;
  const idleSeconds = (now - lastActivityAt) / 1000;
  // 把"是否颜色提示卡顿"的阈值放在 UI 这一层而不是 formatter 里：
  // formatter 决定文本，UI 决定外观，两者职责分开更易调。
  const color = idleSeconds >= 15 ? "yellow" : "gray";
  return <Text color={color}>{formatBusyStatus(elapsedSeconds, idleSeconds)}</Text>;
}

function StatusBar({ width, busy, state, tokenUsage }: { width: number; busy: boolean; state: AgentState; tokenUsage: TokenUsage }) {
  const left = currentResolved
    ? `[${currentResolved.providerName}] ${currentResolved.model}`
    : "[no-model]";
  const mid = `${state.turnCount} turns`;
  const totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;
  const right = busy
    ? "working · Esc to stop"
    : (totalTokens > 0
      ? `${formatNum(tokenUsage.inputTokens)}→ ${formatNum(tokenUsage.outputTokens)}↗ ${tokenUsage.cost.toFixed(4)}`
      : `~${estimateTokens(state.chatHistory)} token`);
  const text = `${left} | ${mid} | ${right}`;

  return (
    <Text color="gray" wrap="truncate">
      {ellipsize(text, width)}
    </Text>
  );
}

function helpMessage(): string {
  const providers = getProviderNames();
  const providerList = providers.length > 0 ? providers.join(", ") : "(none configured)";
  const skillCommands = skillLoader.getPromptCommands();
  const skillsLine = skillCommands.length > 0
    ? `skills     /${skillCommands.slice(0, 8).map((command) => command.name).join(", /")}${skillCommands.length > 8 ? ", ..." : ""}`
    : "skills     (none available)";
  return [
    "help                show available commands",
    "status              show session status",
    "usage               show codex subscription usage (5h / weekly limits)",
    "mcp [refresh [name]] show MCP status or refresh all / one server",
    "team                show teammate statuses",
    "inbox               drain lead inbox",
    "provider [name]     switch provider (no arg = list providers)",
    "model [name]        switch model within current provider",
    "compact             compact conversation history to free context space",
    "new                 clear context and start a new conversation",
    "resume [sessionId]  list recent sessions or restore one",
    "exit                exit the CLI",
    skillsLine,
    "",
    `config     ${getSettingsPath()}`,
    `providers  ${providerList}`,
    "",
    "Press Esc while working to stop the current turn without clearing session context.",
    "Use Cmd+V (or Ctrl+V) to import a clipboard image as an attachment on macOS.",
    "Slash variants also work, for example /help and /exit.",
    "Dragging an image file into the terminal attaches it automatically.",
    "Anything else is sent directly to the model.",
  ].join("\n");
}

// P1 异步化：lead 邮箱未读数走 MessageBus.unreadCount（async）。
// status 命令本身已经在 async 上下文中调用，把 sessionStatus 改成 async 即可。
async function sessionStatus(state: AgentState, tokenUsage?: TokenUsage): Promise<string> {
  const mcpSummary = mcpManager.getStatusSummary();
  const modelsLine = currentResolved.availableModels.length > 0
    ? `models   ${currentResolved.availableModels.join(", ")}`
    : "";
  const effectiveBaseURL = getEffectiveBaseURL(currentResolved, currentAuthState);
  const leadUnread = await messageBus.unreadCount("lead");
  return [
    `workspace ${WORKDIR}`,
    `provider ${currentResolved.providerName}`,
    `model    ${currentResolved.model}`,
    modelsLine,
    `api mode ${currentResolved.apiMode}`,
    `baseURL  ${currentResolved.baseURL}`,
    `effective endpoint ${effectiveBaseURL}`,
    formatAuthSummary(currentAuthState),
    `session  ${state.sessionId}`,
    `turns    ${state.turnCount}`,
    `context  ~${estimateActiveContextTokens(state)} tokens | compacted: ${state.compactCount} times`,
    tokenUsage && tokenUsage.inputTokens + tokenUsage.outputTokens > 0
      ? `tokens   ${formatNum(tokenUsage.inputTokens)} in → ${formatNum(tokenUsage.outputTokens)} out  ${tokenUsage.cost.toFixed(4)}`
      : `tokens   ~${estimateTokens(state.chatHistory)} (estimated)`,
    `mcp      ${mcpSummary.connected} connected | ${mcpSummary.degraded} degraded | ${mcpSummary.disconnected} disconnected | ${mcpSummary.enabled} enabled`,
    `team     ${teammateManager.listMembers().length} teammates | lead inbox: ${leadUnread}`,
    `uptime   ${formatDuration(Date.now() - state.launchedAt)}`,
  ].filter(Boolean).join("\n");
}

/**
 * 把运行时 UI 消息裁成可落盘的结构。
 *
 * 为什么不直接保存完整 `UiMessage`：
 * - `id` 只服务当前渲染树，恢复后重新分配更简单，也能避免和新消息冲突。
 * - header 这类纯展示占位消息不属于真实会话内容，恢复时重新生成即可。
 * - 持久化层只保留继续会话所需的信息，避免把瞬时渲染细节写进 transcript。
 */
function serializeMessages(messages: UiMessage[]): PersistedUiMessage[] {
  return messages
    .filter((message) => message.id !== "header")
    .map((message) => ({
      kind: message.kind,
      title: message.title,
      subtitle: message.subtitle,
      text: message.text,
      diffLines: message.diffLines ? [...message.diffLines] : undefined,
      collapsed: message.collapsed,
    }));
}

/**
 * 把落盘消息恢复成当前会话可渲染的 `UiMessage`。
 *
 * 为什么恢复时重建 ID：
 * - Ink 的消息列表只要求本次进程内唯一，不要求跨会话稳定。
 * - 按顺序重新编号可以让恢复逻辑保持纯函数，不依赖旧进程的计数器状态。
 * - 这也保证后续新增消息继续接在末尾，不会撞上历史 ID。
 */
function restoreMessages(messages: PersistedUiMessage[]): UiMessage[] {
  return messages.map((message, index) => ({
    id: `message-${index + 1}`,
    kind: message.kind,
    title: message.title,
    subtitle: message.subtitle,
    text: message.text,
    diffLines: message.diffLines ? [...message.diffLines] : undefined,
    collapsed: message.collapsed,
  }));
}

/**
 * 生成当前会话的持久化快照。
 *
 * 为什么快照里同时放 `AgentState` 和 UI 消息：
 * - 仅恢复 `chatHistory/responseHistory` 只能让模型继续工作，但用户会看到空白界面。
 * - 仅恢复 UI 消息又无法把模型上下文接上，等于只是“查看历史”而不是继续会话。
 * - 两者一起保存可以把 `/resume` 做成真正的“从上次中断处继续”。
 */
function buildSessionSnapshot(state: AgentState, messages: UiMessage[]): SessionSnapshot {
  return {
    state: {
      ...state,
      responseHistory: JSON.parse(JSON.stringify(state.responseHistory)),
      chatHistory: JSON.parse(JSON.stringify(state.chatHistory)),
    },
    messages: serializeMessages(messages),
    providerName: currentResolved?.providerName,
    model: currentResolved?.model,
    apiMode: currentResolved?.apiMode,
    savedAt: new Date().toISOString(),
  };
}

/**
 * 把最近 session 列表格式化成 CLI 可读文本。
 *
 * 为什么保留短标题和 turns：
 * - 恢复操作的本质是帮助用户从多个历史上下文里快速定位目标会话。
 * - 仅显示 sessionId 太难识别，标题能提供主题，turn 数和模型能补充上下文规模。
 * - 文本格式保持简单，后续若要改成交互选择器也可以直接复用这份摘要数据。
 */
function formatRecentSessions(currentSessionId: string): string {
  const sessions = listRecentSessions(WORKDIR);
  if (sessions.length === 0) {
    return "No saved sessions for this workspace yet.";
  }

  return [
    "Recent sessions:",
    ...sessions.map((session) => {
      const activeMark = session.sessionId === currentSessionId ? " ← current" : "";
      const modelInfo = [session.providerName, session.model].filter(Boolean).join("/");
      const suffix = modelInfo ? ` · ${modelInfo}` : "";
      return `  ${session.sessionId}${activeMark} · ${session.turnCount} turns · ${session.savedAt}${suffix}\n    ${session.title}`;
    }),
    "",
    "Use /resume <sessionId> to restore one.",
  ].join("\n");
}

/**
 * Resolve startup argv into an optional preloaded session snapshot.
 *
 * Why this happens before Ink mounts:
 * - `xbcode resume <id>` should land in the restored session immediately
 *   instead of booting an empty UI and then replaying a command.
 * - Startup restore may also need to switch provider/model first so the in-memory
 *   agent state matches the resumed transcript before the first turn.
 * - Returning a small structured result lets the UI reuse the same rendering
 *   path whether startup resume succeeded, failed, or only requested a list.
 */
function resolveStartupResumeState(): StartupResumeState {
  const startupCommand = parseStartupCommand(process.argv.slice(2));
  if (startupCommand.kind !== "resume") {
    return {
      hasResolvedModel: !needsModelSelection(),
    };
  }

  if (!startupCommand.sessionId) {
    return {
      startupMessage: {
        id: "startup-resume",
        kind: "system",
        title: "resume",
        text: formatRecentSessions(""),
      },
      hasResolvedModel: !needsModelSelection(),
    };
  }

  const snapshot = loadSession(WORKDIR, startupCommand.sessionId);
  if (!snapshot) {
    return {
      startupMessage: {
        id: "startup-resume",
        kind: "error",
        title: "resume",
        text: `Session not found: "${startupCommand.sessionId}"`,
      },
      hasResolvedModel: !needsModelSelection(),
    };
  }

  let hasResolvedModel = !needsModelSelection();
  let startupMessage: UiMessage | undefined = {
    id: "startup-resume",
    kind: "system",
    title: "resume",
    text: `Resumed session ${snapshot.state.sessionId}.`,
  };

  if (snapshot.providerName && snapshot.model) {
    try {
      ensureConfig(snapshot.providerName, snapshot.model);
      hasResolvedModel = true;
    } catch (error) {
      startupMessage = {
        id: "startup-resume",
        kind: "error",
        title: "resume",
        text: `Restored session state, but could not switch model to ${snapshot.providerName}/${snapshot.model}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  return {
    snapshot,
    startupMessage,
    hasResolvedModel,
  };
}

// P1：buildLeadInboxQuery 已废弃。新的 runOneTurn helper（见组件内部）
// 直接拼接 formatTeammateMessages + 用户 query，不再用 <user_request> 包裹。

function findSlashCommandMatches(inputValue: string): SlashCommand[] {
  if (!inputValue.startsWith("/")) {
    return [];
  }

  const query = inputValue.trim().toLowerCase();
  if (query === "/") {
    return getAllSlashCommands();
  }

  return getAllSlashCommands().filter(({ command }) => command.startsWith(query));
}

function parseSkillSlashInvocation(inputValue: string): SkillSlashInvocation | null {
  const trimmed = inputValue.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const withoutSlash = trimmed.slice(1).trim();
  if (!withoutSlash) {
    return null;
  }

  const firstSpaceIndex = withoutSlash.search(/\s/);
  const commandName = (firstSpaceIndex === -1 ? withoutSlash : withoutSlash.slice(0, firstSpaceIndex)).trim();
  if (!commandName || !skillLoader.getCommand(commandName)) {
    return null;
  }

  const args = firstSpaceIndex === -1 ? "" : withoutSlash.slice(firstSpaceIndex + 1).trim();
  return {
    command: commandName,
    args: args || undefined,
  };
}

function getVisibleSlashMatches(matches: SlashCommand[], selectedIndex: number): {
  items: SlashCommand[];
  start: number;
  hiddenAbove: number;
  hiddenBelow: number;
} {
  if (matches.length <= MAX_VISIBLE_SLASH_MATCHES) {
    return {
      items: matches,
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    };
  }

  const maxStart = Math.max(0, matches.length - MAX_VISIBLE_SLASH_MATCHES);
  const idealStart = selectedIndex - Math.floor(MAX_VISIBLE_SLASH_MATCHES / 2);
  const start = Math.max(0, Math.min(maxStart, idealStart));
  const end = Math.min(matches.length, start + MAX_VISIBLE_SLASH_MATCHES);

  return {
    items: matches.slice(start, end),
    start,
    hiddenAbove: start,
    hiddenBelow: matches.length - end,
  };
}

function buildMessageRows(message: UiMessage, width: number): ViewportRow[] {
  const { titleColor, bodyColor } = getMessagePalette(message.kind);
  const marker = getMessageMarker(message.kind);
  const contentWidth = Math.max(1, width - 2);
  const rows: Array<{ text: string; color?: string; dimColor?: boolean }> = [];
  const appendRows = (text: string, color?: string, dimColor = false) => {
    for (const row of wrapTextToRows(text, contentWidth)) {
      rows.push({ text: row, color, dimColor });
    }
  };

  if (message.kind === "tool" && message.diffLines && message.diffLines.length > 0) {
    if (message.title) {
      appendRows(message.title, "yellow");
    }
    if (message.subtitle) {
      appendRows(`  ${message.subtitle}`, "gray");
    }
    for (const line of message.diffLines) {
      appendRows(line.text, line.color);
    }

    return rows.map((row, index) => ({
      id: `${message.id}-${index}`,
      prefix: index === 0 ? "● " : "  ",
      prefixColor: index === 0 ? "yellow" : undefined,
      text: row.text,
      color: row.color,
      dimColor: row.dimColor,
    }));
  }

  if (message.kind === "thinking" && message.collapsed) {
    const lineCount = (message.text || "").split("\n").length;
    const preview = ellipsize((message.text || "").split("\n")[0].trim(), 60);
    appendRows(`[thinking · ${lineCount} lines] ${preview}`, "blue", true);
    return rows.map((row, index) => ({
      id: `${message.id}-${index}`,
      prefix: index === 0 ? "▸ " : "  ",
      prefixColor: index === 0 ? "gray" : undefined,
      text: row.text,
      color: row.color,
      dimColor: row.dimColor,
    }));
  }

  const displayText = message.kind === "assistant"
    ? renderMarkdown(message.text || " ")
    : (message.text || " ");

  if (message.title) {
    appendRows(`[${message.title}]`, titleColor);
  }
  appendRows(displayText, message.kind === "assistant" ? undefined : bodyColor, message.kind === "thinking");

  return rows.map((row, index) => ({
    id: `${message.id}-${index}`,
    prefix: index === 0 ? `${marker?.symbol ?? " "} ` : "  ",
    prefixColor: index === 0 ? marker?.color : undefined,
    text: row.text,
    color: row.color,
    dimColor: row.dimColor,
  }));
}

function ViewportRowView({ row }: { row: ViewportRow }) {
  return (
    <Text wrap="truncate-end" color={row.color} dimColor={row.dimColor}>
      <Text color={row.prefixColor}>{row.prefix}</Text>
      {row.text}
    </Text>
  );
}

function MessageBlock({ message, width }: { message: UiMessage; width: number }) {
  const rows = buildMessageRows(message, width);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {rows.map((row) => (
        <ViewportRowView key={row.id} row={row} />
      ))}
    </Box>
  );
}

function TrustPrompt({ selectedIndex }: TrustPromptProps) {
  const options = ["Yes, continue", "No, quit"];

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>You are in {WORKDIR}</Text>
      <Text>Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.</Text>
      <Newline />
      {options.map((label, index) => (
        <Text key={label} color={selectedIndex === index ? "cyan" : "white"}>
          {selectedIndex === index ? "›" : " "} {index + 1}. {label}
        </Text>
      ))}
      <Newline />
      <Text color="gray">Use ↑/↓ to choose, Enter to confirm</Text>
    </Box>
  );
}

type ModelSelectPromptProps = Readonly<{
  choices: ModelChoice[];
  selectedIndex: number;
  activeModelId?: string;
}>;

function ModelSelectPrompt({ choices, selectedIndex, activeModelId }: ModelSelectPromptProps) {
  if (choices.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="red">No models configured.</Text>
        <Text>Edit <Text color="cyan">{getSettingsPath()}</Text> to add providers and models.</Text>
      </Box>
    );
  }

  // Compute column widths for alignment
  const indexWidth = String(choices.length).length + 2; // "1. " etc.
  const nameWidth = Math.max(...choices.map((c) => c.displayName.length)) + 3; // padding + checkmark

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="green">Select model</Text>
      <Text color="gray">Switch between models. Applies to this session.</Text>
      <Text> </Text>
      {choices.map(({ displayName, description, modelId }, index) => {
        const isSelected = index === selectedIndex;
        const isActive = modelId === activeModelId;
        const prefix = isSelected ? "› " : "  ";
        const num = `${index + 1}.`;
        const check = isActive ? " ✓" : "";
        const nameCol = `${displayName}${check}`;
        const descCol = description ? `· ${description}` : "";

        return (
          <Text key={`${modelId}-${index}`} color={isSelected ? "cyan" : undefined}>
            {prefix}{num.padEnd(indexWidth)}{nameCol.padEnd(nameWidth)}{descCol}
          </Text>
        );
      })}
      <Text> </Text>
      <Text color="gray">Use ↑/↓ to choose, Enter to confirm, Esc to cancel</Text>
    </Box>
  );
}

function CliApp({ startupResume }: { startupResume: StartupResumeState }) {
  const { exit } = useApp();
  const initialRestoredMessages = startupResume.snapshot ? restoreMessages(startupResume.snapshot.messages) : [];
  const initialMessages = [
    headerItem(),
    ...initialRestoredMessages,
    ...(startupResume.startupMessage ? [startupResume.startupMessage] : []),
  ];
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const messagesRef = useRef<UiMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ImageAttachment[]>([]);
  // P1：busyRef 与 busy state 镜像，给 onSend("lead") listener 闭包用。
  // 闭包读 state 会拿旧值，必须用 ref 读最新值。所有 setBusy 调用处同步更新此 ref。
  const busyRef = useRef(false);
  // 心跳指示器：turn 起始时间 + 最近一次 stream 活动时间。每秒 tick 一次重渲染，
  // UI 用它显示 "Working 12s · idle 7s · Esc to stop"，让用户能区分
  // "模型还在 thinking/talking" 和 "连接 stall / 网关缓冲"。
  //
  // 之所以走 useEffect([busy]) 集中管理，而不是在每个 setBusy 调用点初始化 ref：
  // - setBusy(true) 在多个分支（手动 submit、idle 唤醒、resume）都会调用，
  //   单点初始化漏写一处就会导致 "Working 0s" 永远不更新；
  // - useEffect 在 React 渲染稳定后只触发一次，对 ref 写入即使在 strict mode 也可控。
  const turnStartedAtRef = useRef<number | null>(null);
  const lastActivityAtRef = useRef<number | null>(null);
  const [busyTick, setBusyTick] = useState(0);
  useEffect(() => {
    if (busy) {
      const now = Date.now();
      turnStartedAtRef.current = now;
      lastActivityAtRef.current = now;
      const interval = setInterval(() => setBusyTick((t) => t + 1), 1000);
      return () => clearInterval(interval);
    }
    turnStartedAtRef.current = null;
    lastActivityAtRef.current = null;
    return undefined;
  }, [busy]);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  /**
   * Startup can begin with a fully resolved model when either:
   * - the user set `MODEL_ID` for this shell session, or
   * - persisted defaults already point at a valid configured model.
   *
   * Why this state is initialized eagerly:
   * - The render tree has two different concerns: whether the picker is open
   *   (`modelSelected`) and whether the footer should describe an active model
   *   (`userHasChosenModel`).
   * - When startup skips the picker we must mark both as ready immediately,
   *   otherwise the UI ends up in a contradictory state where the header and
   *   status bar show a model while the footer still says "No model selected".
   */
  const startupHasResolvedModel = startupResume.hasResolvedModel;
  const [modelSelected, setModelSelected] = useState<boolean>(startupHasResolvedModel);
  const [userHasChosenModel, setUserHasChosenModel] = useState(startupHasResolvedModel);
  const [trustSelection, setTrustSelection] = useState(0);
  const [modelSelectionIndex, setModelSelectionIndex] = useState(0);
  const [slashSelection, setSlashSelection] = useState(0);
  const [streamingId, setStreamingId] = useState<string | undefined>(undefined);
  const modelChoices = useRef(buildModelChoices());
  const [terminalSize, setTerminalSize] = useState({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  const messageCounterRef = useRef(initialRestoredMessages.length + (startupResume.startupMessage ? 1 : 0));
  const [sessionKey, setSessionKey] = useState(0);
  const [totalTokenUsage, setTotalTokenUsage] = useState<TokenUsage>({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 });
  const assistantMessageIdRef = useRef<string | undefined>(undefined);
  const thinkingMessageIdRef = useRef<string | undefined>(undefined);
  const skipSubmitRef = useRef(false);
  const submitDeduperRef = useRef(createSubmitDeduper());
  const loginInFlightRef = useRef(false);
  const activeTurnAbortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const startupMcpReportShownRef = useRef(false);
  // Human-in-the-loop tool approval. `pendingApproval` drives the overlay; the
  // resolver settles the promise the agent loop is awaiting; the allowlist
  // remembers "always allow <tool>" choices for the lifetime of this session.
  const [pendingApproval, setPendingApproval] = useState<{ name: string; args: ToolArgs; lines: string[] } | null>(null);
  const [approvalSelection, setApprovalSelection] = useState(0);
  const approvalResolverRef = useRef<((decision: ToolApprovalDecision) => void) | null>(null);
  const alwaysAllowToolsRef = useRef<Set<string>>(new Set());
  const agentStateRef = useRef<AgentState>({
    ...(startupResume.snapshot?.state ?? {
      sessionId: createSessionId(),
      responseHistory: [],
      chatHistory: [],
      turnCount: 0,
      launchedAt: Date.now(),
      roundsSinceTask: 0,
      compactCount: 0,
    }),
  });

  const slashMatches = findSlashCommandMatches(inputValue);
  const showSlashMenu = trusted === true && !busy && slashMatches.length > 0;
  const activeSlashIndex = Math.min(slashSelection, Math.max(0, slashMatches.length - 1));
  const visibleSlashMenu = getVisibleSlashMatches(slashMatches, activeSlashIndex);

  useEffect(() => {
    setSlashSelection(0);
  }, [inputValue]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    messagesRef.current = initialMessages;
  }, []);

  const requestExit = () => {
    /**
     * 这里只依赖 Ink 的 exit() 不够稳妥：
     * 它会卸载界面，但如果事件循环里还残留句柄，Node 进程可能继续存活，
     * 用户就会看到 `/exit` 像是“没反应”。因此这里先走正常卸载，
     * 再在下一个 tick 强制结束进程，确保命令语义就是立即退出。
     */
    if (messagesRef.current.length > 1) {
      persistCurrentSession();
    }
    exit();
    setImmediate(() => {
      process.exit(0);
    });
  };

  useEffect(() => {
    const handleResize = () => {
      // Ink's <Static> output is append-only. After a resize, wrapped line counts change,
      // so we clear and remount the tree to prevent old rows from lingering on screen.
      process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
      setSessionKey((current) => current + 1);
      setTerminalSize({
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      });
    };

    process.stdout.on("resize", handleResize);
    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  const pushMessage = (kind: UiMessage["kind"], text: string, title?: string) => {
    messageCounterRef.current += 1;
    const id = `message-${messageCounterRef.current}`;
    setMessages((current) => {
      const next = [...current, { id, kind, title, text }];
      messagesRef.current = next;
      return next;
    });
  };

  /**
   * 把当前会话安全地写入本地 transcript。
   *
   * 为什么把持久化失败吞成系统消息而不是直接抛错：
   * - 会话保存属于增强能力，不能因为磁盘问题阻断主对话流程。
   * - 用户仍然需要知道“恢复能力不可用”，所以这里转成可见告警最合适。
   * - 写入始终基于当前内存态快照，不依赖异步队列，避免进程退出时再丢一次。
   */
  const persistCurrentSession = () => {
    try {
      appendSessionCheckpoint(WORKDIR, buildSessionSnapshot(agentStateRef.current, messagesRef.current));
    } catch (error) {
      pushMessage("error", `Failed to save session: ${error instanceof Error ? error.message : String(error)}`, "session");
    }
  };

  const importClipboardImage = async () => {
    try {
      const attachment = await importClipboardImageMacos();
      setPendingAttachments((current) => [...current, attachment]);
      pushMessage("system", `Attached image from clipboard: ${path.basename(attachment.path)}`, "image");
    } catch (error) {
      pushMessage("error", error instanceof Error ? error.message : String(error), "image");
    }
  };

  const appendStreamingMessage = (kind: "assistant" | "thinking", ref: StringRef, delta: string, title?: string) => {
    if (!delta) {
      return;
    }

    setMessages((current) => {
      if (!ref.current) {
        messageCounterRef.current += 1;
        ref.current = `message-${messageCounterRef.current}`;
        setStreamingId(ref.current);
        const next = [...current, { id: ref.current, kind, title, text: delta }];
        messagesRef.current = next;
        return next;
      }

      const next = current.map((message) => (message.id === ref.current ? { ...message, text: `${message.text}${delta}` } : message));
      messagesRef.current = next;
      return next;
    });
  };

  const finalizeStreaming = () => {
    assistantMessageIdRef.current = undefined;
    thinkingMessageIdRef.current = undefined;
    setStreamingId(undefined);
  };

  const bridge: UiBridge = {
    appendAssistantDelta(delta) {
      lastActivityAtRef.current = Date.now();
      appendStreamingMessage("assistant", assistantMessageIdRef, delta);
    },
    appendThinkingDelta(delta) {
      lastActivityAtRef.current = Date.now();
      appendStreamingMessage("thinking", thinkingMessageIdRef, delta, "thinking");
    },
    finalizeStreaming() {
      finalizeStreaming();
    },
    noteStreamActivity() {
      lastActivityAtRef.current = Date.now();
    },
    pushAssistant(text) {
      pushMessage("assistant", text);
    },
    pushTool(name, args, result) {
      // tool 完成本身也算"活动"——否则一个 60s 的 bash 跑完时，
      // 距离上次 stream event 已经过去 60s，UI 会显示 "idle 60s" 让用户误判为卡死。
      // 这里把 tool 完成时间点也喂给心跳，配合 stream 事件就能覆盖大多数正常路径。
      lastActivityAtRef.current = Date.now();
      finalizeStreaming();
      const display = formatToolDisplay(name, args, result);
      if (display) {
        messageCounterRef.current += 1;
        const id = `message-${messageCounterRef.current}`;
        setMessages((current) => {
          const next = [
            ...current,
            {
              id,
              kind: "tool" as const,
              title: display.title,
              subtitle: display.subtitle,
              text: "",
              diffLines: display.lines.map((l) => ({ text: l.text, color: l.color })),
            },
          ];
          messagesRef.current = next;
          return next;
        });
      } else {
        pushMessage("tool", `args  ${toolPreview(JSON.stringify(args))}\nresult  ${toolPreview(result)}`, `tool ${name}`);
      }
    },
    updateUsage(usage: TokenUsage) {
      setTotalTokenUsage(usage);
    },
    requestToolApproval(name, args) {
      // Already approved for the session — run without prompting.
      if (alwaysAllowToolsRef.current.has(name)) {
        return Promise.resolve<ToolApprovalDecision>("approved");
      }
      finalizeStreaming();
      return new Promise<ToolApprovalDecision>((resolve) => {
        approvalResolverRef.current = resolve;
        setApprovalSelection(0);
        setPendingApproval({ name, args, lines: summarizeApprovalTarget(name, args) });
      });
    },
  };

  // Settle a pending approval and tear down the overlay. `alwaysAllowName`, when
  // set, remembers the tool so future calls skip the prompt this session.
  const resolveApproval = (decision: ToolApprovalDecision, alwaysAllowName?: string) => {
    if (alwaysAllowName) {
      alwaysAllowToolsRef.current.add(alwaysAllowName);
    }
    const resolve = approvalResolverRef.current;
    approvalResolverRef.current = null;
    setPendingApproval(null);
    setApprovalSelection(0);
    resolve?.(decision);
  };

  const resetConversation = (snapshot?: SessionSnapshot) => {
    assistantMessageIdRef.current = undefined;
    thinkingMessageIdRef.current = undefined;
    setStreamingId(undefined);
    setPendingAttachments([]);
    agentStateRef.current = snapshot?.state ?? {
      sessionId: createSessionId(),
      responseHistory: [],
      chatHistory: [],
      turnCount: 0,
      launchedAt: Date.now(),
      roundsSinceTask: 0,
      compactCount: 0,
    };

    const restoredMessages = snapshot ? restoreMessages(snapshot.messages) : [];
    messageCounterRef.current = restoredMessages.length;
    // Clear the terminal then remount <Static> with fresh messages.
    process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
    setSessionKey((k) => k + 1);
    messagesRef.current = [headerItem(), ...restoredMessages];
    setMessages(messagesRef.current);
  };

  const clearPendingAttachments = () => {
    setPendingAttachments([]);
  };

  const attachImagesFromText = (rawValue: string): { value: string; newlyAttached: ImageAttachment[] } => {
    const { attachments, remainingText } = extractImagePathsFromText(rawValue);
    if (attachments.length === 0) {
      return { value: rawValue, newlyAttached: [] };
    }

    const newlyAttached: ImageAttachment[] = [];
    setPendingAttachments((current) => {
      const existing = new Set(current.map((attachment) => attachment.path));
      const next = [...current];
      for (const attachment of attachments) {
        if (!existing.has(attachment.path)) {
          next.push(attachment);
          newlyAttached.push(attachment);
          existing.add(attachment.path);
          pushMessage("system", `Attached image: ${path.basename(attachment.path)}`, "image");
        }
      }
      return next;
    });

    return { value: remainingText, newlyAttached };
  };

  const requestActiveTurnStop = () => {
    const controller = activeTurnAbortRef.current;
    if (!controller || controller.signal.aborted || stopRequestedRef.current) {
      return;
    }

    stopRequestedRef.current = true;
    controller.abort();
    pushMessage("system", "Stopping current turn. Session context will be kept.", "stop");
  };

  const acceptTrust = () => {
    setTrusted(true);
    if (modelSelected) {
      // env var already set, skip selection
      if (!currentResolved) ensureConfig();
      setUserHasChosenModel(true);
      primeMcpRuntime();
      if (messagesRef.current.length === 0) {
        messagesRef.current = [headerItem()];
        setMessages(messagesRef.current);
      }
    }
  };

  const acceptModelSelection = (index: number) => {
    const choice = modelChoices.current[index];
    if (!choice) return;
    const isInitialSelection = messages.length === 0;
    finalizeStreaming();
    ensureConfig(choice.provider, choice.modelId);
    setModelSelected(true);
    setUserHasChosenModel(true);
    primeMcpRuntime();
    if (isInitialSelection && messagesRef.current.length <= 1) {
      messagesRef.current = [headerItem()];
      setMessages(messagesRef.current);
    } else {
      // Clear screen and rebuild <Static> to avoid Ink re-rendering stale items out of order
      messageCounterRef.current += 1;
      const switchMsg: UiMessage = {
        id: `message-${messageCounterRef.current}`,
        kind: "system",
        title: "model",
        text: `Switched to model "${choice.displayName}" (provider: ${choice.provider})`,
      };
      process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
      setSessionKey((k) => k + 1);
      setMessages((current) => {
        const next = [...current, switchMsg];
        messagesRef.current = next;
        return next;
      });
    }
  };

  const handleTrustInput = (input: string, key: { upArrow?: boolean; downArrow?: boolean; return?: boolean }) => {
    if (key.upArrow || input === "k") {
      setTrustSelection((current) => (current - 1 + 2) % 2);
      return;
    }

    if (key.downArrow || input === "j") {
      setTrustSelection((current) => (current + 1) % 2);
      return;
    }

    if (key.return) {
      if (trustSelection === 0) {
        acceptTrust();
      } else {
        requestExit();
      }
      return;
    }

    if (["1", "y", "Y"].includes(input)) {
      acceptTrust();
      return;
    }

    if (["2", "n", "N", "q", "Q"].includes(input)) {
      requestExit();
    }
  };

  // P1 单轮运行入口：把未读 lead 消息 + 用户 query 合并注入，调用 runAgentTurn。
  // 之所以拆成 helper：用户主动提交（带 query）和自动续轮（query 为空）共用同一段逻辑，避免重复。
  // 命名为 runOneTurn 与 spec §3.5 对齐。
  const runOneTurn = async (userQuery: string, attachments: ImageAttachment[], signal: AbortSignal): Promise<void> => {
    const unread = await messageBus.readUnread("lead");
    let injected = "";
    if (unread.length > 0) {
      await messageBus.markRead("lead", unread);
      pushMessage("system", `(injecting ${unread.length} teammate message(s))`, "inbox");
      injected = formatTeammateMessages(unread);
    }

    const effectiveQuery = userQuery && injected
      ? `${injected}\n\n${userQuery}`
      : (userQuery || injected);

    if (!effectiveQuery) return; // 双空：无事可做

    await runAgentTurn(
      agentConfig,
      effectiveQuery,
      attachments,
      agentStateRef.current,
      bridge,
      { signal },
    );
  };

  // P1 lead idle 唤醒：listener 触发，但当前轮在跑就什么都不做（路径 A 的 while 兜底）。
  // 只有 lead 当前空闲才主动开一轮。
  const triggerLeadAutoTurn = async (): Promise<void> => {
    if (busyRef.current) return;
    if ((await messageBus.unreadCount("lead")) === 0) return;

    setBusy(true); busyRef.current = true;
    stopRequestedRef.current = false;
    const abortController = new AbortController();
    activeTurnAbortRef.current = abortController;

    try {
      await ensureMcpInitialized();
      await refreshCurrentAuth();
      await runOneTurn("", [], abortController.signal);
      while (
        !abortController.signal.aborted
        && (await messageBus.unreadCount("lead")) > 0
      ) {
        pushMessage("system", "(continuing turn for teammate message(s))", "inbox");
        await runOneTurn("", [], abortController.signal);
      }
    } catch (error) {
      finalizeStreaming();
      if (isTurnInterruptedError(error)) {
        pushMessage("system", "Stopped current turn. Session context preserved.", "stop");
      } else {
        pushMessage("error", error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      finalizeStreaming();
      persistCurrentSession();
      activeTurnAbortRef.current = null;
      stopRequestedRef.current = false;
      setBusy(false); busyRef.current = false;
    }
  };

  // P1：注册 onSend("lead") listener。teammate / 工具调用 send(to=lead) 后，
  // 写盘成功立刻触发此处回调；如果 lead 不在跑（busyRef=false）就主动开一轮。
  // useEffect 空依赖：只在挂载时注册一次，卸载时 unregister。
  useEffect(() => {
    const unregister = messageBus.onSend("lead", () => {
      void triggerLeadAutoTurn();
    });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitQuery = async (query: string, attachments: ImageAttachment[] = []) => {
    const trimmed = query.trim();
    if ((!trimmed && attachments.length === 0) || busy) {
      return;
    }

    const command = attachments.length > 0 ? null : normalizeCommand(trimmed);
    const skillSlashInvocation = command ? null : parseSkillSlashInvocation(trimmed);
    const hasSelectedModel = userHasChosenModel && Boolean(currentResolved);

    if (["q", "exit"].includes(trimmed.toLowerCase()) || command === "exit") {
      requestExit();
      return;
    }

    if (!hasSelectedModel && submissionNeedsSelectedModel(trimmed, Boolean(skillSlashInvocation))) {
      pushMessage("error", "No model selected. Use /model to select one.", "model");
      return;
    }

    if (command) {
      if (command === "help") {
        pushMessage("system", helpMessage(), "help");
        return;
      }

      if (command === "status") {
        await ensureMcpInitialized();
        await refreshCurrentAuth();
        pushMessage("system", await sessionStatus(agentStateRef.current, totalTokenUsage), "status");
        return;
      }

      if (command === "usage") {
        /**
         * `/usage` 走的是 ChatGPT backend `/wham/usage`，所以前置条件是：
         * 1. 当前 provider 必须是 openai；
         * 2. 必须以 oauth 模式登录（API key 模式拿不到订阅维度的额度信息）。
         *
         * 为什么这里要先 refreshCurrentAuth：
         * - 用户可能上次登录后过了好几天才用 /usage，access_token 大概率已经过期；
         * - 这一步会用 refresh_token 主动续期，并把新的 token 写回 credentials 文件，
         *   后面真正请求 /wham/usage 时就不会再收到 401。
         */
        if (currentResolved.providerName !== "openai") {
          pushMessage(
            "error",
            `/usage 仅支持 openai provider，当前 provider 是 "${currentResolved.providerName}"。请先 /provider openai。`,
            "usage",
          );
          return;
        }

        await refreshCurrentAuth();

        const credentials = currentAuthState?.oauth;
        if (currentAuthState?.authMode !== "oauth" || !credentials?.access_token) {
          pushMessage(
            "error",
            "/usage 需要 openai oauth 登录，未检测到有效凭据。请先 /login openai。",
            "usage",
          );
          return;
        }

        try {
          const usage = await fetchOpenAIUsage(credentials);
          pushMessage("system", formatUsageReport(usage), "usage");
        } catch (error) {
          if (error instanceof UsageRequestError) {
            // status + body 一起带出来，方便用户区分是 token 过期（401）、账号未启用 codex（403）
            // 还是 backend 临时故障（5xx）。body 截断到 200 字符避免刷屏。
            const bodyPreview = error.body
              ? ` body=${error.body.slice(0, 200)}${error.body.length > 200 ? "..." : ""}`
              : "";
            pushMessage(
              "error",
              `${error.message}${error.status ? ` (status=${error.status})` : ""}${bodyPreview}`,
              "usage",
            );
          } else {
            pushMessage(
              "error",
              `获取订阅用量失败：${error instanceof Error ? error.message : String(error)}`,
              "usage",
            );
          }
        }
        return;
      }

      if (command.startsWith("mcp")) {
        const mcpArgs = command.slice(3).trim();

        try {
          if (!mcpArgs) {
            await ensureMcpInitialized();
            pushMessage("system", mcpManager.formatStatusReport(), "mcp");
            return;
          }

          if (mcpArgs === "refresh") {
            await refreshMcpFromSettings();
            agentConfig = createAgentConfig(currentResolved, currentAuthState);
            pushMessage("system", mcpManager.formatStatusReport(), "mcp");
            return;
          }

          if (mcpArgs.startsWith("refresh ")) {
            const serverName = mcpArgs.slice("refresh ".length).trim();
            if (!serverName) {
              pushMessage("error", 'Usage: /mcp refresh <name>', "mcp");
              return;
            }
            await refreshMcpFromSettings(serverName);
            agentConfig = createAgentConfig(currentResolved, currentAuthState);
            pushMessage("system", mcpManager.formatStatusReport(), "mcp");
            return;
          }

          pushMessage("error", 'Unknown MCP command. Use "/mcp" or "/mcp refresh [name]".', "mcp");
          return;
        } catch (error) {
          pushMessage("error", error instanceof Error ? error.message : String(error), "mcp");
          return;
        }
      }

      if (command === "team") {
        // P1：formatTeamStatus 已异步化（并发查询每个成员的未读数）。
        pushMessage("system", await teammateManager.formatTeamStatus(), "team");
        return;
      }

      if (command === "tasks") {
        pushMessage("system", await taskManager.list(), "tasks");
        return;
      }

      if (command.startsWith("task")) {
        const taskArg = command.slice(4).trim();
        if (!taskArg) {
          pushMessage("error", 'Usage: "/task <id>"', "task");
          return;
        }

        const taskId = Number(taskArg);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          pushMessage("error", `Invalid task id: "${taskArg}"`, "task");
          return;
        }

        const task = await taskManager.getTask(taskId);
        if (!task) {
          pushMessage("error", `Task not found: #${taskId}`, "task");
          return;
        }

        // P1：删除 thread 事件展示。MessageBus.readThread 已废弃；
        // P3 协议消息阶段会用独立机制（不再复用 mailbox）做事件审计。
        pushMessage("system", await taskManager.formatTask(taskId), "task");
        return;
      }

      if (command === "inbox") {
        // P1：/inbox 改为只读视图（含已读+未读全部历史），便于调试。
        // 自动注入由 runOneTurn 在新一轮开始时处理，不再需要用户手动 drain。
        const all = await messageBus.readAll("lead");
        const formatted = all.length === 0
          ? "(empty inbox)"
          : all
              .map((m) => `[${m.timestamp}] ${m.from} ${m.read ? "(read)" : "(UNREAD)"}\n${m.text}`)
              .join("\n\n");
        pushMessage("system", formatted, "inbox");
        return;
      }

      if (command === "new") {
        resetConversation();
        return;
      }

      if (command.startsWith("resume")) {
        const sessionArg = command.slice(6).trim();
        if (!sessionArg) {
          pushMessage("system", formatRecentSessions(agentStateRef.current.sessionId), "resume");
          return;
        }

        const snapshot = loadSession(WORKDIR, sessionArg);
        if (!snapshot) {
          pushMessage("error", `Session not found: "${sessionArg}"`, "resume");
          return;
        }

        if (snapshot.providerName && snapshot.model) {
          try {
            ensureConfig(snapshot.providerName, snapshot.model);
            setUserHasChosenModel(true);
          } catch (error) {
            pushMessage(
              "error",
              `Restored session state, but could not switch model to ${snapshot.providerName}/${snapshot.model}: ${error instanceof Error ? error.message : String(error)}`,
              "resume",
            );
          }
        }

        resetConversation(snapshot);
        pushMessage("system", `Resumed session ${snapshot.state.sessionId}.`, "resume");
        return;
      }

      if (command === "compact") {
        const state = agentStateRef.current;
        if (agentConfig.apiMode === "chat-completions") {
          const before = estimateTokens(state.chatHistory);
          pushMessage("system", "Compacting conversation history...", "compact");
          const compacted = await autoCompact(agentConfig.client, agentConfig.model, state.chatHistory);
          state.chatHistory.length = 0;
          state.chatHistory.push(...compacted.messages);
          state.compactCount += 1;
          const after = estimateTokens(state.chatHistory);
          pushMessage("system", `Compacted: ~${before} → ~${after} tokens`, "compact");
        } else {
          const before = estimateTokens(state.responseHistory as any);
          if (state.responseHistory.length > 0) {
            pushMessage("system", "Compacting Responses API context chain...", "compact");
            const compacted = await autoCompactResponseHistory(
              agentConfig.client,
              agentConfig.model,
              state.responseHistory,
            );
            state.responseHistory = compacted.messages;
            state.pendingCompactedContext = agentConfig.supportsPreviousResponseId
              ? compacted.continuationMessage
              : undefined;
          }
          state.previousResponseId = undefined;
          state.compactCount += 1;
          const after = estimateTokens(state.responseHistory as any);
          pushMessage("system", `Responses context compacted: ~${before} → ~${after} tokens`, "compact");
        }
        return;
      }

      if (command.startsWith("provider")) {
        const providerArg = command.slice(8).trim();
        reloadSettings();
        const providers = getProviderNames();

        if (!providerArg) {
          if (providers.length === 0) {
            pushMessage("system", `No providers configured.\nEdit ${getSettingsPath()} to add providers.`, "provider");
          } else {
            const lines = providers.map((p) => {
              const marker = p === currentResolved.providerName ? " ← active" : "";
              const models = getProviderModels(p);
              return `  ${p}${marker}  [${models.join(", ")}]`;
            });
            pushMessage("system", `Available providers:\n${lines.join("\n")}\n\nUsage: /provider <name>`, "provider");
          }
          return;
        }

        if (!providers.includes(providerArg)) {
          pushMessage("error", `Unknown provider: "${providerArg}". Available: ${providers.join(", ") || "(none)"}`, "provider");
          return;
        }

        currentResolved = resolveConfig(providerArg);
        currentAuthState = resolveProviderAuthState(loadSettings(), currentResolved.providerName, loadCredentialsFile(getCredentialsPath()));
        agentConfig = createAgentConfig(currentResolved, currentAuthState);
        setUserHasChosenModel(true);
        pushMessage("system", `Switched to provider "${providerArg}"\nmodel=${currentResolved.model} models=[${currentResolved.availableModels.join(", ")}]`, "provider");
        return;
      }

      if (command.startsWith("model")) {
        const modelArg = command.slice(5).trim();

        if (!modelArg) {
          // Show interactive model selection UI
          modelChoices.current = buildModelChoices();
          // Pre-select the currently active model
          const activeIdx = modelChoices.current.findIndex((c) => c.modelId === currentResolved.model && c.provider === currentResolved.providerName);
          setModelSelectionIndex(activeIdx >= 0 ? activeIdx : 0);
          setModelSelected(false);
          return;
        }

        // Direct model switch by name — search across all providers
        const allChoices = buildModelChoices();
        const match = allChoices.find((c) => c.modelId === modelArg);
        if (!match) {
          pushMessage("error", `Unknown model: "${modelArg}". Use /model to see available models.`, "model");
          return;
        }

        ensureConfig(match.provider, match.modelId);
        setUserHasChosenModel(true);
        pushMessage("system", `Switched to model "${match.displayName}" (provider: ${match.provider})`, "model");
        return;
      }

      if (command.startsWith("login")) {
        const providerArg = command.slice(5).trim() || currentResolved.providerName;
        const settings = loadSettings();
        const provider = settings.providers[providerArg];
        if (!provider) {
          pushMessage("error", `Unknown provider: "${providerArg}"`, "login");
          return;
        }
        if (providerArg !== "openai" || provider.auth?.type !== "oauth") {
          pushMessage("error", `Provider "${providerArg}" is not configured for OAuth.`, "login");
          return;
        }
        /**
         * OAuth login relies on a single in-memory state value for the current
         * browser round-trip. If `/login` is triggered twice before the first
         * callback returns, the second invocation replaces the expected state and
         * the first browser redirect is rejected as a mismatch. This guard keeps
         * the CSRF check intact while preventing overlapping login attempts.
         */
        if (loginInFlightRef.current) {
          pushMessage("system", "OpenAI OAuth login is already in progress.", "login");
          return;
        }

        pushMessage("system", "Starting OpenAI OAuth login. A browser URL will be shown below.", "login");
        loginInFlightRef.current = true;
        try {
          const result = await startOpenAILogin({
            openUrl: (url) => {
              pushMessage("system", `Open this URL to continue login:\n${url}`, "login");
            },
          });

          const credentials = loadCredentialsFile(getCredentialsPath());
          await writeCredentialsFile(getCredentialsPath(), {
            providers: {
              ...credentials.providers,
              [providerArg]: {
                ...result.credentials,
                email: credentials.providers[providerArg]?.email,
              },
            },
          });

          ensureConfig(providerArg, currentResolved.model);
          let syncedModelCount = 0;
          try {
            const discoveredModels = await listAvailableModels({
              accessToken: result.credentials.access_token ?? "",
              baseURL: provider.baseURL,
            });
            if (discoveredModels.length > 0) {
              await updateProviderModels(getSettingsPath(), providerArg, discoveredModels);
              reloadSettings();
              const nextModel = discoveredModels.includes(currentResolved.model)
                ? currentResolved.model
                : (discoveredModels[0] ?? currentResolved.model);
              ensureConfig(providerArg, nextModel);
              syncedModelCount = discoveredModels.length;
            }
          } catch (error) {
            /**
             * Model sync is a post-login convenience step. Failing it should not
             * discard a valid OAuth session, so we surface the error separately
             * and keep the successful login result.
             */
            pushMessage("system", `OAuth login succeeded, but model sync failed: ${error instanceof Error ? error.message : String(error)}`, "login");
          }

          pushMessage(
            "system",
            syncedModelCount > 0
              ? `Logged in to "${providerArg}" with OAuth. Synced ${syncedModelCount} models.`
              : `Logged in to "${providerArg}" with OAuth.`,
            "login",
          );
        } finally {
          loginInFlightRef.current = false;
        }
        return;
      }

      if (command.startsWith("logout")) {
        const providerArg = command.slice(6).trim() || currentResolved.providerName;
        await clearProviderCredentials(getCredentialsPath(), providerArg);
        ensureConfig(providerArg, currentResolved.model);
        pushMessage("system", `Cleared OAuth credentials for "${providerArg}".`, "logout");
        return;
      }
    }

    if (trimmed.startsWith("/")) {
      if (skillSlashInvocation) {
        pushMessage("user", trimmed);
        setBusy(true); busyRef.current = true;
        stopRequestedRef.current = false;
        const abortController = new AbortController();
        activeTurnAbortRef.current = abortController;

        try {
          await ensureMcpInitialized();
          await refreshCurrentAuth();
          await runAgentTurn(
            agentConfig,
            skillLoader.renderSkill(skillSlashInvocation.command, skillSlashInvocation.args),
            [],
            agentStateRef.current,
            bridge,
            { signal: abortController.signal },
          );
        } catch (error) {
          finalizeStreaming();
          if (isTurnInterruptedError(error)) {
            const stopMessage = agentConfig.apiMode === "responses" && !error.responseId
              ? "Stopped current turn. Prior session context was kept. Resend the interrupted prompt if you want to continue it."
              : "Stopped current turn. Session context preserved.";
            pushMessage("system", stopMessage, "stop");
          } else {
            pushMessage("error", error instanceof Error ? error.message : String(error), "error");
          }
        } finally {
          finalizeStreaming();
          persistCurrentSession();
          activeTurnAbortRef.current = null;
          stopRequestedRef.current = false;
          setBusy(false); busyRef.current = false;
        }
        return;
      }

      pushMessage("error", `Unknown command: ${trimmed}. Try help or /help`, "error");
      return;
    }

    pushMessage("user", trimmed);
    setBusy(true); busyRef.current = true;
    stopRequestedRef.current = false;
    const abortController = new AbortController();
    activeTurnAbortRef.current = abortController;

    try {
      await ensureMcpInitialized();
      await refreshCurrentAuth();

      // P1：用户主动提交时合并未读邮件 + 用户 query 一起注入。
      await runOneTurn(trimmed, attachments, abortController.signal);

      // 严格 CC 自动续轮：邮箱有未读就持续开新轮，直到清空或被 abort。
      // 为什么不加熔断：北哥要求严格对齐 CC，CC 自身也无熔断。
      // 安全网仍在：用户随时可 Ctrl+C / Esc 触发 abortController。
      while (
        !abortController.signal.aborted
        && (await messageBus.unreadCount("lead")) > 0
      ) {
        pushMessage("system", "(continuing turn for teammate message(s))", "inbox");
        await runOneTurn("", [], abortController.signal);
      }
    } catch (error) {
      finalizeStreaming();
      if (isTurnInterruptedError(error)) {
        const stopMessage = agentConfig.apiMode === "responses" && !error.responseId
          ? "Stopped current turn. Prior session context was kept. Resend the interrupted prompt if you want to continue it."
          : "Stopped current turn. Session context preserved.";
        pushMessage("system", stopMessage, "stop");
      } else {
        pushMessage("error", error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      finalizeStreaming();
      persistCurrentSession();
      activeTurnAbortRef.current = null;
      stopRequestedRef.current = false;
      setBusy(false); busyRef.current = false;
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      requestExit();
      return;
    }

    if ((key.meta || key.ctrl) && input.toLowerCase() === "v" && !busy && trusted === true && modelSelected) {
      void importClipboardImage();
      return;
    }

    if (trusted === null) {
      handleTrustInput(input, key);
      return;
    }

    if (!modelSelected) {
      const choices = modelChoices.current;
      const count = choices.length;
      if (count === 0) return;

      if (key.upArrow || input === "k") {
        setModelSelectionIndex((c) => (c - 1 + count) % count);
        return;
      }
      if (key.downArrow || input === "j") {
        setModelSelectionIndex((c) => (c + 1) % count);
        return;
      }
      if (key.return) {
        acceptModelSelection(modelSelectionIndex);
        return;
      }
      if (key.escape) {
        setModelSelected(true);
        if (!currentResolved) ensureConfig();
        messagesRef.current = [headerItem()];
        setMessages(messagesRef.current);
        return;
      }
      return;
    }

    if (pendingApproval) {
      const optionCount = 3;
      const confirm = (index: number) => {
        if (index === 0) resolveApproval("approved");
        else if (index === 1) resolveApproval("approved", pendingApproval.name);
        else resolveApproval("rejected");
      };
      if (key.escape) {
        resolveApproval("rejected");
      } else if (key.upArrow || input === "k") {
        setApprovalSelection((c) => (c - 1 + optionCount) % optionCount);
      } else if (key.downArrow || input === "j") {
        setApprovalSelection((c) => (c + 1) % optionCount);
      } else if (input === "1" || input === "2" || input === "3") {
        confirm(Number(input) - 1);
      } else if (key.return) {
        confirm(approvalSelection);
      }
      return;
    }

    if (busy) {
      if (key.escape) {
        requestActiveTurnStop();
      }
      return;
    }

    const submittedValue = getSubmittedValueFromInput(inputValue, input, key.return);
    if (submittedValue !== null) {
      handleSubmit(submittedValue);
      return;
    }

    if (showSlashMenu) {
      if (key.escape) {
        setInputValue("");
        return;
      }
      if (key.upArrow) {
        setSlashSelection((current) => (current - 1 + slashMatches.length) % slashMatches.length);
        return;
      }

      if (key.downArrow) {
        setSlashSelection((current) => (current + 1) % slashMatches.length);
        return;
      }

      if (key.tab) {
        skipSubmitRef.current = true;
        setInputValue(slashMatches[activeSlashIndex]?.command ?? inputValue);
        return;
      }
    }

  });

  const handleSubmit = (value: string) => {
    // Enter 可能同时从 TextInput 和父级 useInput 两条路径冒出来。
    // 这里统一做去重，避免兜底提交把同一条输入执行两次。
    if (!submitDeduperRef.current.shouldSubmit(value)) {
      return;
    }

    if (showSlashMenu) {
      const selectedCommand = slashMatches[activeSlashIndex]?.command ?? value;
      setInputValue("");
      void submitQuery(selectedCommand);
      return;
    }

    if (skipSubmitRef.current) {
      skipSubmitRef.current = false;
      return;
    }

    const normalized = attachImagesFromText(value);
    const attachments = [...pendingAttachments, ...normalized.newlyAttached];
    setInputValue("");
    clearPendingAttachments();
    void submitQuery(normalized.value, attachments);
  };

  const innerWidth = Math.max(0, Math.min(terminalSize.columns - 2, 110));

  // Determine which overlay to show (trust / model selection / none)
  const showTrustPrompt = trusted === null;
  const showModelSelect = !showTrustPrompt && !modelSelected;
  const showMainUi = !showTrustPrompt && modelSelected;

  /**
   * 历史消息交给 Ink 的 <Static> 输出到终端 scrollback，
   * 进入滚动缓冲区后即可由终端原生支持鼠标滚轮与拖动复制。
   * 流式中的消息不放进 static（delta 会频繁变动），而是在底部动态区渲染，
   * 流式结束后 streamingId 变为 undefined，该消息自动归入 static 列表。
   */
  const liveMessage = streamingId ? messages.find((m) => m.id === streamingId) : undefined;
  const staticMessages = streamingId ? messages.filter((m) => m.id !== streamingId) : messages;

  useEffect(() => {
    if (trusted !== true || !modelSelected || !currentResolved || startupMcpReportShownRef.current) {
      return;
    }

    startupMcpReportShownRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        await ensureMcpInitialized();
        if (cancelled) {
          return;
        }
        pushMessage("system", mcpManager.formatStartupReport(), "mcp");
      } catch (error) {
        if (cancelled) {
          return;
        }
        pushMessage("error", error instanceof Error ? error.message : String(error), "mcp");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [trusted, modelSelected, userHasChosenModel]);

  return (
    <Box key={`session-${sessionKey}`} flexDirection="column" paddingX={1}>
      {/* Trust prompt overlay */}
      {showTrustPrompt ? (
        <>
          <Box flexDirection="column" marginBottom={1}>
            <Text color="blue" wrap="truncate">{borderRule(innerWidth)}</Text>
            <Text color="blue">xbcode <Text color="gray">CLI</Text></Text>
            <Text color="gray" wrap="truncate">workspace {WORKDIR}</Text>
            <Text color="blue" wrap="truncate">{borderRule(innerWidth)}</Text>
          </Box>
          <TrustPrompt selectedIndex={trustSelection} />
        </>
      ) : null}

      {/* Model selection overlay */}
      {showModelSelect ? (
        <ModelSelectPrompt choices={modelChoices.current} selectedIndex={modelSelectionIndex} activeModelId={currentResolved?.model} />
      ) : null}

      {/* Main chat UI */}
      {showMainUi ? (
        <>
          {/**
           * Static 把历史消息一次性 flush 到 stdout，内容进入终端 scrollback。
           * 用户即可通过鼠标滚轮滚动（由终端原生处理）、拖动选中复制文本。
           * 首项是 header，用 WelcomePanel 渲染。
           */}
          <Static items={staticMessages}>
            {(item) => (
              item.id === "header"
                ? <WelcomePanel key={item.id} width={innerWidth} messages={messages} />
                : <MessageBlock key={item.id} message={item} width={innerWidth} />
            )}
          </Static>

          {/* 流式中的消息：频繁追加 delta，留在动态区实时重绘 */}
          {liveMessage ? <MessageBlock message={liveMessage} width={innerWidth} /> : null}

          <Box flexDirection="column" width="100%" flexShrink={0}>
            <Text color="white" wrap="truncate">{borderRule(innerWidth)}</Text>
            <StatusBar width={innerWidth} busy={busy} state={agentStateRef.current} tokenUsage={totalTokenUsage} />
            {pendingApproval ? (
              <ApprovalPrompt name={pendingApproval.name} lines={pendingApproval.lines} selectedIndex={approvalSelection} width={innerWidth} />
            ) : busy ? (
              <BusyStatusLine
                busyTick={busyTick}
                turnStartedAtRef={turnStartedAtRef}
                lastActivityAtRef={lastActivityAtRef}
              />
            ) : null}
            <Box width="100%" flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text>› </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <TextInput value={inputValue} onChange={(value) => setInputValue(attachImagesFromText(value).value)} onSubmit={handleSubmit} focus={!busy} showCursor={!busy} />
              </Box>
            </Box>
            {pendingAttachments.length > 0 ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color="yellow">Attachments ({pendingAttachments.length})</Text>
                {pendingAttachments.map((attachment, index) => (
                  <Text key={`${attachment.path}-${index}`} color="gray">  {index + 1}. {path.basename(attachment.path)} · {attachment.mimeType}</Text>
                ))}
              </Box>
            ) : null}
            {showSlashMenu ? (
              <Box flexDirection="column" marginTop={1}>
                {visibleSlashMenu.hiddenAbove > 0 ? (
                  <Text color="gray">  ↑ {visibleSlashMenu.hiddenAbove} more</Text>
                ) : null}
                {visibleSlashMenu.items.map(({ command, description }, index) => {
                  const absoluteIndex = visibleSlashMenu.start + index;
                  const selected = absoluteIndex === activeSlashIndex;

                  return (
                    <Box key={command}>
                      <Box width={2}>
                        <Text color={selected ? "cyan" : "gray"}>{selected ? "*" : " "}</Text>
                      </Box>
                      <Text color={selected ? "cyan" : "white"}>{command}</Text>
                      <Text color="gray"> – {description}</Text>
                    </Box>
                  );
                })}
                {visibleSlashMenu.hiddenBelow > 0 ? (
                  <Text color="gray">  ↓ {visibleSlashMenu.hiddenBelow} more</Text>
                ) : null}
              </Box>
            ) : null}
            <Text color="white" wrap="truncate">{borderRule(innerWidth)}</Text>
            {userHasChosenModel && currentResolved
              ? <Text color="gray">{currentResolved.providerName}: {currentResolved.model} | api: {currentResolved.apiMode} | attachments: {pendingAttachments.length} | {ellipsize(getEffectiveBaseURL(currentResolved, currentAuthState), 32)}</Text>
              : <Text color="red">No model selected. Use /model to select one.</Text>}
          </Box>
        </>
      ) : null}
    </Box>
  );
}

const startupResume = resolveStartupResumeState();
const app = render(<CliApp startupResume={startupResume} />, { exitOnCtrlC: false });
await app.waitUntilExit();
/**
 * Ink 的 exit() 只保证卸载 TUI，不保证 Node 进程一定结束。
 * 这个 CLI 在退出后仍可能保留活跃句柄（例如底层流、计时器或连接），
 * 导致界面看起来“没退出”。这里显式结束进程，确保 `/exit` 的行为稳定符合预期。
 */
process.exit(0);
