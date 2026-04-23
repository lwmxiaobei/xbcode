#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { config as loadDotenv } from "dotenv";
import fs from "node:fs";
import { Box, Newline, Text, render, useApp, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import OpenAI from "openai";
import { useEffect, useRef, useState } from "react";
import wrapAnsi from "wrap-ansi";

import pkg from "../package.json" with { type: "json" };

import { isTurnInterruptedError, runAgentTurn, type AgentConfig } from "./agent.js";
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
import { estimateTokens, autoCompact } from "./compact.js";
import { normalizeCommand, parseStartupCommand } from "./commands.js";
import { createSubmitDeduper, getSubmittedValueFromInput } from "./input-submit.js";
import { formatMailboxMessages, renderInboxPrompt } from "./message-bus.js";
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
import { skillLoader, messageBus, teammateManager } from "./tools.js";
import type { AgentState, DiffLine, PersistedUiMessage, UiBridge, UiMessage } from "./types.js";
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
  { command: "/login", description: "start oauth login for the current provider" },
  { command: "/logout", description: "clear oauth credentials for the current provider" },
  { command: "/mcp", description: "show MCP server status" },
  { command: "/mcp refresh", description: "refresh MCP caches and reconnect servers" },
  { command: "/team", description: "show teammate statuses" },
  { command: "/inbox", description: "drain lead inbox" },
  { command: "/provider", description: "switch provider" },
  { command: "/model", description: "switch model within current provider" },
  { command: "/mouse", description: "toggle mouse wheel capture mode" },
  { command: "/compact", description: "compact conversation history to free context space" },
  { command: "/new", description: "clear context and start a new conversation" },
  { command: "/resume", description: "list recent saved sessions or restore one by id" },
  { command: "/exit", description: "exit the CLI" },
];

const MOUSE_INPUT_SEQUENCE_RE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

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

function parseMouseInputSequence(input: string): { kind: "wheel"; delta: number } | { kind: "other" } | null {
  const match = MOUSE_INPUT_SEQUENCE_RE.exec(input);
  if (!match) {
    return null;
  }

  const code = Number(match[1]);
  if ((code & 64) === 64) {
    return { kind: "wheel", delta: (code & 1) === 0 ? 3 : -3 };
  }

  return { kind: "other" };
}

function mouseWheelStatusLabel(enabled: boolean): string {
  return enabled ? "wheel capture on" : "copy mode";
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
      return { titleColor: "gray", bodyColor: "gray" };
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

function StatusBar({ width, busy, state, scrollOffset }: { width: number; busy: boolean; state: AgentState; scrollOffset: number }) {
  const left = currentResolved
    ? `[${currentResolved.providerName}] ${currentResolved.model}`
    : "[no-model]";
  const mid = `${state.turnCount} turns`;
  const right = busy ? "working · Esc to stop" : `~${estimateTokens(state.chatHistory)} token`;
  const history = scrollOffset > 0 ? ` | history ↑${scrollOffset}` : "";
  const text = `${left} | ${mid} | ${right}${history}`;

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
    "mcp [refresh [name]] show MCP status or refresh all / one server",
    "team                show teammate statuses",
    "inbox               drain lead inbox",
    "provider [name]     switch provider (no arg = list providers)",
    "model [name]        switch model within current provider",
    "mouse [on|off]      toggle mouse wheel capture; off restores drag-to-copy",
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
    "Use PgUp/PgDn/Home/End to browse message history.",
    "Slash variants also work, for example /help and /exit.",
    "Anything else is sent directly to the model.",
  ].join("\n");
}

function sessionStatus(state: AgentState): string {
  const mcpSummary = mcpManager.getStatusSummary();
  const modelsLine = currentResolved.availableModels.length > 0
    ? `models   ${currentResolved.availableModels.join(", ")}`
    : "";
  const effectiveBaseURL = getEffectiveBaseURL(currentResolved, currentAuthState);
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
    `mcp      ${mcpSummary.connected} connected | ${mcpSummary.degraded} degraded | ${mcpSummary.disconnected} disconnected | ${mcpSummary.enabled} enabled`,
    `team     ${teammateManager.listMembers().length} teammates | lead inbox: ${messageBus.inboxSize("lead")}`,
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

function buildLeadInboxQuery(inboxPrompt: string, userQuery: string): string {
  return `${inboxPrompt}\n\n<user_request>\n${userQuery}\n</user_request>`;
}

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
    appendRows(`[thinking · ${lineCount} lines] ${preview}`, "gray", true);
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

function buildViewportRows(messages: UiMessage[], width: number): ViewportRow[] {
  const rows: ViewportRow[] = [];

  messages.forEach((message, index) => {
    rows.push(...buildMessageRows(message, width));
    if (index < messages.length - 1) {
      rows.push({
        id: `${message.id}-spacer`,
        prefix: "  ",
        text: " ",
      });
    }
  });

  return rows;
}

function selectVisibleRows(rows: ViewportRow[], availableLines: number, scrollOffset: number): {
  rows: ViewportRow[];
  maxScrollOffset: number;
  effectiveScrollOffset: number;
} {
  if (availableLines <= 0) {
    return { rows: [], maxScrollOffset: 0, effectiveScrollOffset: 0 };
  }

  const maxScrollOffset = Math.max(0, rows.length - availableLines);
  const effectiveScrollOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset));
  const endExclusive = rows.length - effectiveScrollOffset;
  const start = Math.max(0, endExclusive - availableLines);

  return {
    rows: rows.slice(start, endExclusive),
    maxScrollOffset,
    effectiveScrollOffset,
  };
}

function ViewportRowView({ row }: { row: ViewportRow }) {
  return (
    <Text wrap="truncate-end" color={row.color} dimColor={row.dimColor}>
      <Text color={row.prefixColor}>{row.prefix}</Text>
      {row.text}
    </Text>
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
  const { internal_eventEmitter } = useStdin();
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
  const [mouseWheelEnabled, setMouseWheelEnabled] = useState(false);
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
  const [scrollOffset, setScrollOffset] = useState(0);
  const modelChoices = useRef(buildModelChoices());
  const [terminalSize, setTerminalSize] = useState({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  const messageCounterRef = useRef(initialRestoredMessages.length + (startupResume.startupMessage ? 1 : 0));
  const [sessionKey, setSessionKey] = useState(0);
  const assistantMessageIdRef = useRef<string | undefined>(undefined);
  const thinkingMessageIdRef = useRef<string | undefined>(undefined);
  const skipSubmitRef = useRef(false);
  const submitDeduperRef = useRef(createSubmitDeduper());
  const loginInFlightRef = useRef(false);
  const activeTurnAbortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const startupMcpReportShownRef = useRef(false);
  const maxScrollOffsetRef = useRef(0);
  const pageScrollSizeRef = useRef(10);
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

  const clampScrollOffset = (value: number): number => Math.max(0, Math.min(maxScrollOffsetRef.current, value));
  const scrollHistoryBy = (delta: number) => {
    setScrollOffset((current) => clampScrollOffset(current + delta));
  };
  const scrollHistoryToLatest = () => {
    setScrollOffset(0);
  };
  const scrollHistoryToOldest = () => {
    setScrollOffset(maxScrollOffsetRef.current);
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

  const appendStreamingMessage = (kind: "assistant" | "thinking", ref: StringRef, delta: string, title?: string) => {
    if (!delta) {
      return;
    }

    setMessages((current) => {
      if (!ref.current) {
        messageCounterRef.current += 1;
        ref.current = `message-${messageCounterRef.current}`;
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
  };

  const bridge: UiBridge = {
    appendAssistantDelta(delta) {
      appendStreamingMessage("assistant", assistantMessageIdRef, delta);
    },
    appendThinkingDelta(delta) {
      appendStreamingMessage("thinking", thinkingMessageIdRef, delta, "thinking");
    },
    finalizeStreaming() {
      finalizeStreaming();
    },
    pushAssistant(text) {
      pushMessage("assistant", text);
    },
    pushTool(name, args, result) {
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
  };

  const resetConversation = (snapshot?: SessionSnapshot) => {
    assistantMessageIdRef.current = undefined;
    thinkingMessageIdRef.current = undefined;
    scrollHistoryToLatest();
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
      scrollHistoryToLatest();
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
    scrollHistoryToLatest();
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

  const submitQuery = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || busy) {
      return;
    }

    const command = normalizeCommand(trimmed);
    const skillSlashInvocation = command ? null : parseSkillSlashInvocation(trimmed);

    if (["q", "exit"].includes(trimmed.toLowerCase()) || command === "exit") {
      requestExit();
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
        pushMessage("system", sessionStatus(agentStateRef.current), "status");
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
        pushMessage("system", teammateManager.formatTeamStatus(), "team");
        return;
      }

      if (command === "inbox") {
        pushMessage("system", formatMailboxMessages(messageBus.drainInbox("lead")), "inbox");
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
          state.chatHistory.push(...compacted);
          state.compactCount += 1;
          const after = estimateTokens(state.chatHistory);
          pushMessage("system", `Compacted: ~${before} → ~${after} tokens`, "compact");
        } else {
          state.previousResponseId = undefined;
          state.responseHistory = [];
          state.compactCount += 1;
          pushMessage("system", "Responses API context chain reset.", "compact");
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

      if (command.startsWith("mouse")) {
        const mouseArg = command.slice(5).trim().toLowerCase();
        let nextValue: boolean;

        if (!mouseArg) {
          nextValue = !mouseWheelEnabled;
        } else if (["on", "enable", "enabled"].includes(mouseArg)) {
          nextValue = true;
        } else if (["off", "disable", "disabled"].includes(mouseArg)) {
          nextValue = false;
        } else if (["status", "state"].includes(mouseArg)) {
          pushMessage("system", `Mouse mode: ${mouseWheelStatusLabel(mouseWheelEnabled)}.`, "mouse");
          return;
        } else {
          pushMessage("error", 'Usage: /mouse [on|off|status]', "mouse");
          return;
        }

        setMouseWheelEnabled(nextValue);
        pushMessage(
          "system",
          nextValue
            ? "Mouse wheel capture enabled. Terminal drag-to-copy may stop working."
            : "Mouse wheel capture disabled. Terminal drag-to-copy is restored.",
          "mouse",
        );
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
        scrollHistoryToLatest();
        setBusy(true);
        stopRequestedRef.current = false;
        const abortController = new AbortController();
        activeTurnAbortRef.current = abortController;

        try {
          await ensureMcpInitialized();
          await refreshCurrentAuth();
          await runAgentTurn(
            agentConfig,
            skillLoader.renderSkill(skillSlashInvocation.command, skillSlashInvocation.args),
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
          setBusy(false);
        }
        return;
      }

      pushMessage("error", `Unknown command: ${trimmed}. Try help or /help`, "error");
      return;
    }

    pushMessage("user", trimmed);
    scrollHistoryToLatest();
    setBusy(true);
    stopRequestedRef.current = false;
    const abortController = new AbortController();
    activeTurnAbortRef.current = abortController;

    try {
      await ensureMcpInitialized();
      await refreshCurrentAuth();

      const leadInbox = messageBus.drainInbox("lead");
      if (leadInbox.length > 0) {
        pushMessage("system", formatMailboxMessages(leadInbox), "inbox");
      }

      const effectiveQuery = leadInbox.length > 0
        ? buildLeadInboxQuery(renderInboxPrompt(leadInbox), trimmed)
        : trimmed;

      await runAgentTurn(agentConfig, effectiveQuery, agentStateRef.current, bridge, { signal: abortController.signal });
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
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      requestExit();
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
        scrollHistoryToLatest();
        messagesRef.current = [headerItem()];
        setMessages(messagesRef.current);
        return;
      }
      return;
    }

    if (key.pageUp) {
      scrollHistoryBy(pageScrollSizeRef.current);
      return;
    }

    if (key.pageDown) {
      scrollHistoryBy(-pageScrollSizeRef.current);
      return;
    }

    if (key.home && (busy || inputValue.length === 0)) {
      scrollHistoryToOldest();
      return;
    }

    if (key.end && (busy || inputValue.length === 0)) {
      scrollHistoryToLatest();
      return;
    }

    if (busy) {
      if (key.upArrow || input === "k") {
        scrollHistoryBy(1);
        return;
      }
      if (key.downArrow || input === "j") {
        scrollHistoryBy(-1);
        return;
      }
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

    if (inputValue.length === 0) {
      if (key.upArrow || input === "k") {
        scrollHistoryBy(1);
        return;
      }

      if (key.downArrow || input === "j") {
        scrollHistoryBy(-1);
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

    setInputValue("");
    void submitQuery(value);
  };

  const innerWidth = Math.max(0, Math.min(terminalSize.columns - 2, 110));

  const allChatMessages = messages.filter((m) => m.id !== "header");
  const viewportRows = buildViewportRows(allChatMessages, innerWidth);

  // Determine which overlay to show (trust / model selection / none)
  const showTrustPrompt = trusted === null;
  const showModelSelect = !showTrustPrompt && !modelSelected;
  const showMainUi = !showTrustPrompt && modelSelected;
  const slashMenuLines = showSlashMenu
    ? visibleSlashMenu.items.length + (visibleSlashMenu.hiddenAbove > 0 ? 1 : 0) + (visibleSlashMenu.hiddenBelow > 0 ? 1 : 0)
    : 0;
  const reservedLines = 18 + (busy ? 1 : 0) + slashMenuLines;
  const availableMessageLines = Math.max(1, terminalSize.rows - reservedLines);
  const { rows: visibleRows, maxScrollOffset, effectiveScrollOffset } = selectVisibleRows(viewportRows, availableMessageLines, scrollOffset);

  maxScrollOffsetRef.current = maxScrollOffset;
  pageScrollSizeRef.current = Math.max(1, availableMessageLines - 2);

  useEffect(() => {
    setScrollOffset((current) => clampScrollOffset(current));
  }, [maxScrollOffset]);

  useEffect(() => {
    if (!showMainUi || !process.stdout.isTTY || !mouseWheelEnabled) {
      return;
    }

    /**
     * Ink 不提供滚轮事件，所以这里直接拦 stdin 的 SGR 鼠标序列。
     * 仅消费 wheel，其他鼠标事件继续交给 Ink，避免把点击语义混进滚动逻辑。
     */
    const emitter = internal_eventEmitter as EventEmitter;
    const originalEmit = emitter.emit.bind(emitter);
    const patchedEmit: EventEmitter["emit"] = ((eventName: string | symbol, ...args: unknown[]) => {
      if (eventName === "input" && typeof args[0] === "string") {
        const mouseInput = parseMouseInputSequence(args[0]);
        if (mouseInput) {
          if (mouseInput.kind === "wheel") {
            setScrollOffset((current) => clampScrollOffset(current + mouseInput.delta));
          }
          return false;
        }
      }

      return originalEmit(eventName, ...args);
    }) as EventEmitter["emit"];

    emitter.emit = patchedEmit;
    process.stdout.write("\x1b[?1000h\x1b[?1006h\x1b[?1007h");

    return () => {
      emitter.emit = originalEmit;
      process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?1007l");
    };
  }, [internal_eventEmitter, mouseWheelEnabled, showMainUi]);

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
    <Box key={`session-${sessionKey}`} flexDirection="column" paddingX={1} height={terminalSize.rows}>
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
          <WelcomePanel width={innerWidth} messages={messages} />

          <Box flexDirection="column">
            {visibleRows.map((row) => (
              <ViewportRowView key={row.id} row={row} />
            ))}
          </Box>

          <Box flexDirection="column" width="100%" flexShrink={0}>
            <Text color="white" wrap="truncate">{borderRule(innerWidth)}</Text>
            <StatusBar width={innerWidth} busy={busy} state={agentStateRef.current} scrollOffset={effectiveScrollOffset} />
            {busy ? <Text color="gray">Working... Esc stops this turn. PgUp/PgDn/Home/End browse history.</Text> : null}
            {!busy ? <Text color="gray">Mouse: {mouseWheelStatusLabel(mouseWheelEnabled)}. Use /mouse on or /mouse off.</Text> : null}
            <Box width="100%" flexDirection="row">
              <Box width={2} flexShrink={0}>
                <Text>› </Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} focus={!busy} showCursor={!busy} />
              </Box>
            </Box>
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
              ? <Text color="gray">{currentResolved.providerName}: {currentResolved.model} | api: {currentResolved.apiMode} | {ellipsize(getEffectiveBaseURL(currentResolved, currentAuthState), 40)}</Text>
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
