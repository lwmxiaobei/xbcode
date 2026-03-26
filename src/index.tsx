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

import { isTurnInterruptedError, runAgentTurn, type AgentConfig } from "./agent.js";
import { resolveConfig, getProviderNames, getProviderModels, loadSettings, reloadSettings, getSettingsPath, normalizeModelEntry, type ResolvedConfig } from "./config.js";
import { estimateTokens, autoCompact } from "./compact.js";
import { formatMailboxMessages, renderInboxPrompt } from "./message-bus.js";
import { skillLoader, messageBus, teammateManager } from "./tools.js";
import type { AgentState, DiffLine, UiBridge, UiMessage } from "./types.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
loadDotenv({ path: path.join(PROJECT_ROOT, ".env"), override: true });

const WORKDIR = process.cwd();

function buildSystemPrompt(): string {
  const SKILL_DESCRIPTIONS = skillLoader.getDescriptions();
  return `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_DESCRIPTIONS}`;
}

function createAgentConfig(resolved: ResolvedConfig): AgentConfig {
  const client = new OpenAI({
    apiKey: resolved.apiKey || undefined,
    baseURL: resolved.baseURL !== "https://api.openai.com/v1" ? resolved.baseURL : undefined,
  });
  return {
    client,
    model: resolved.model,
    system: buildSystemPrompt(),
    showThinking: resolved.showThinking,
    apiMode: resolved.apiMode,
  };
}

// Initialized lazily after user selects model (or immediately if MODEL_ID env var is set)
let currentResolved: ResolvedConfig = undefined!;
let agentConfig: AgentConfig = undefined!;

function ensureConfig(providerName?: string, modelName?: string): void {
  currentResolved = resolveConfig(providerName, modelName);
  agentConfig = createAgentConfig(currentResolved);
}

// If MODEL_ID env var is set, initialize immediately (skip interactive selection)
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

/** Whether the user needs to pick a model interactively */
function needsModelSelection(): boolean {
  // If env var already specifies everything, skip
  if (process.env.MODEL_ID) return false;
  return true;
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

const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/help", description: "show available commands" },
  { command: "/status", description: "show session status" },
  { command: "/team", description: "show teammate statuses" },
  { command: "/inbox", description: "drain lead inbox" },
  { command: "/provider", description: "switch provider" },
  { command: "/model", description: "switch model within current provider" },
  { command: "/compact", description: "compact conversation history to free context space" },
  { command: "/new", description: "clear context and start a new conversation" },
  { command: "/exit", description: "exit the CLI" },
];

const MOUSE_INPUT_SEQUENCE_RE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) {
    return `${remainingSeconds}s`;
  }
  return `${minutes}m${remainingSeconds}s`;
}

function ellipsize(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
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
    text: `provider=${currentResolved.providerName} model=${currentResolved.model} baseURL=${currentResolved.baseURL} apiMode=${currentResolved.apiMode}`,
  };
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
        <Text bold color="red">Claude Code Mini</Text>
        <Text color="gray">v2.1.80</Text>
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
          <Text>Use <Text color="whiteBright">/new</Text> to reset the session and keep the terminal clean.</Text>
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
  return [
    "help                show available commands",
    "status              show session status",
    "team                show teammate statuses",
    "inbox               drain lead inbox",
    "provider [name]     switch provider (no arg = list providers)",
    "model [name]        switch model within current provider",
    "compact             compact conversation history to free context space",
    "new                 clear context and start a new conversation",
    "exit                exit the CLI",
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
  const modelsLine = currentResolved.availableModels.length > 0
    ? `models   ${currentResolved.availableModels.join(", ")}`
    : "";
  return [
    `workspace ${WORKDIR}`,
    `provider ${currentResolved.providerName}`,
    `model    ${currentResolved.model}`,
    modelsLine,
    `api mode ${currentResolved.apiMode}`,
    `baseURL  ${currentResolved.baseURL}`,
    `turns    ${state.turnCount}`,
    `context  ~${estimateTokens(state.chatHistory)} tokens | compacted: ${state.compactCount} times`,
    `team     ${teammateManager.listMembers().length} teammates | lead inbox: ${messageBus.inboxSize("lead")}`,
    `uptime   ${formatDuration(Date.now() - state.launchedAt)}`,
  ].filter(Boolean).join("\n");
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
    return SLASH_COMMANDS;
  }

  return SLASH_COMMANDS.filter(({ command }) => command.startsWith(query));
}

function normalizeCommand(inputValue: string): string | null {
  const trimmed = inputValue.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  const parts = withoutSlash.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case "help":
    case "status":
    case "team":
    case "inbox":
    case "compact":
    case "new":
    case "exit":
      return withoutSlash;
    case "provider":
    case "model":
      return withoutSlash;
    case "quit":
      return "exit";
    default:
      return null;
  }
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

function CliApp() {
  const { exit } = useApp();
  const { internal_eventEmitter } = useStdin();
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [trusted, setTrusted] = useState<boolean | null>(null);
  const [modelSelected, setModelSelected] = useState<boolean>(!needsModelSelection());
  const [userHasChosenModel, setUserHasChosenModel] = useState(false);
  const [trustSelection, setTrustSelection] = useState(0);
  const [modelSelectionIndex, setModelSelectionIndex] = useState(0);
  const [slashSelection, setSlashSelection] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const modelChoices = useRef(buildModelChoices());
  const [terminalSize, setTerminalSize] = useState({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  const messageCounterRef = useRef(0);
  const [sessionKey, setSessionKey] = useState(0);
  const assistantMessageIdRef = useRef<string | undefined>(undefined);
  const thinkingMessageIdRef = useRef<string | undefined>(undefined);
  const skipSubmitRef = useRef(false);
  const activeTurnAbortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const maxScrollOffsetRef = useRef(0);
  const pageScrollSizeRef = useRef(10);
  const agentStateRef = useRef<AgentState>({
    chatHistory: [],
    turnCount: 0,
    launchedAt: Date.now(),
    roundsSinceTask: 0,
    compactCount: 0,
  });

  const slashMatches = findSlashCommandMatches(inputValue);
  const showSlashMenu = trusted === true && !busy && slashMatches.length > 0;
  const activeSlashIndex = Math.min(slashSelection, Math.max(0, slashMatches.length - 1));

  useEffect(() => {
    setSlashSelection(0);
  }, [inputValue]);

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
    setMessages((current) => [
      ...current,
      { id, kind, title, text },
    ]);
  };

  const appendStreamingMessage = (kind: "assistant" | "thinking", ref: StringRef, delta: string, title?: string) => {
    if (!delta) {
      return;
    }

    setMessages((current) => {
      if (!ref.current) {
        messageCounterRef.current += 1;
        ref.current = `message-${messageCounterRef.current}`;
        return [...current, { id: ref.current, kind, title, text: delta }];
      }

      return current.map((message) => (message.id === ref.current ? { ...message, text: `${message.text}${delta}` } : message));
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
        setMessages((current) => [
          ...current,
          {
            id,
            kind: "tool" as const,
            title: display.title,
            subtitle: display.subtitle,
            text: "",
            diffLines: display.lines.map((l) => ({ text: l.text, color: l.color })),
          },
        ]);
      } else {
        pushMessage("tool", `args  ${toolPreview(JSON.stringify(args))}\nresult  ${toolPreview(result)}`, `tool ${name}`);
      }
    },
  };

  const resetConversation = () => {
    assistantMessageIdRef.current = undefined;
    thinkingMessageIdRef.current = undefined;
    scrollHistoryToLatest();
    agentStateRef.current = {
      chatHistory: [],
      turnCount: 0,
      launchedAt: Date.now(),
      roundsSinceTask: 0,
      compactCount: 0,
    };
    messageCounterRef.current = 0;
    // Clear the terminal then remount <Static> with fresh messages.
    process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
    setSessionKey((k) => k + 1);
    setMessages([headerItem()]);
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
      scrollHistoryToLatest();
      setMessages([headerItem()]);
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
    scrollHistoryToLatest();
    if (isInitialSelection) {
      setMessages([headerItem()]);
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
      setMessages((current) => [...current, switchMsg]);
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
        exit();
      }
      return;
    }

    if (["1", "y", "Y"].includes(input)) {
      acceptTrust();
      return;
    }

    if (["2", "n", "N", "q", "Q"].includes(input)) {
      exit();
    }
  };

  const submitQuery = async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed || busy) {
      return;
    }

    const command = normalizeCommand(trimmed);

    if (["q", "exit"].includes(trimmed.toLowerCase()) || command === "exit") {
      exit();
      return;
    }

    if (command) {
      if (command === "help") {
        pushMessage("system", helpMessage(), "help");
        return;
      }

      if (command === "status") {
        pushMessage("system", sessionStatus(agentStateRef.current), "status");
        return;
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
        agentConfig = createAgentConfig(currentResolved);
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
    }

    if (trimmed.startsWith("/")) {
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
      activeTurnAbortRef.current = null;
      stopRequestedRef.current = false;
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
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
        setMessages([headerItem()]);
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
  const reservedLines = 18 + (busy ? 1 : 0) + (showSlashMenu ? slashMatches.length + 1 : 0);
  const availableMessageLines = Math.max(1, terminalSize.rows - reservedLines);
  const { rows: visibleRows, maxScrollOffset, effectiveScrollOffset } = selectVisibleRows(viewportRows, availableMessageLines, scrollOffset);

  maxScrollOffsetRef.current = maxScrollOffset;
  pageScrollSizeRef.current = Math.max(1, availableMessageLines - 2);

  useEffect(() => {
    setScrollOffset((current) => clampScrollOffset(current));
  }, [maxScrollOffset]);

  useEffect(() => {
    if (!showMainUi || !process.stdout.isTTY) {
      return;
    }

    const emitter = internal_eventEmitter as EventEmitter;
    const originalEmit = emitter.emit.bind(emitter);
    const patchedEmit: EventEmitter["emit"] = ((eventName: string | symbol, ...args: unknown[]) => {
      if (eventName === "input" && typeof args[0] === "string") {
        const mouseInput = parseMouseInputSequence(args[0]);
        if (mouseInput) {
          if (mouseInput.kind === "wheel") {
            setScrollOffset((current) => Math.max(0, Math.min(maxScrollOffsetRef.current, current + mouseInput.delta)));
          }
          return false;
        }
      }

      return originalEmit(eventName, ...args);
    }) as EventEmitter["emit"];

    emitter.emit = patchedEmit;
    process.stdout.write("\x1b[?1000h\x1b[?1006h");

    return () => {
      emitter.emit = originalEmit;
      process.stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, [internal_eventEmitter, showMainUi]);

  return (
    <Box key={`session-${sessionKey}`} flexDirection="column" paddingX={1} height={terminalSize.rows}>
      {/* Trust prompt overlay */}
      {showTrustPrompt ? (
        <>
          <Box flexDirection="column" marginBottom={1}>
            <Text color="blue" wrap="truncate">{borderRule(innerWidth)}</Text>
            <Text color="blue">Claude Code Mini <Text color="gray">Code Agent CLI</Text></Text>
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

          <Box flexDirection="column">
              <Text color="white" wrap="truncate">{borderRule(innerWidth)}</Text>
              <StatusBar width={innerWidth} busy={busy} state={agentStateRef.current} scrollOffset={effectiveScrollOffset} />
              {busy ? <Text color="gray">Working... Esc stops this turn. PgUp/PgDn/Home/End browse history.</Text> : null}
              <Box>
                <Text>› </Text>
                <TextInput value={inputValue} onChange={setInputValue} onSubmit={handleSubmit} focus={!busy} showCursor={!busy} />
              </Box>
              {showSlashMenu ? (
                <Box flexDirection="column" marginTop={1}>
                  {slashMatches.map(({ command, description }, index) => {
                    const selected = index === activeSlashIndex;

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
                </Box>
              ) : null}
              <Text color="white" wrap="truncate">{borderRule(innerWidth)}</Text>
          </Box>
          {userHasChosenModel && currentResolved
            ? <Text color="gray">{currentResolved.providerName}: {currentResolved.model} | api: {currentResolved.apiMode} | {ellipsize(currentResolved.baseURL, 40)}</Text>
            : <Text color="red">No model selected. Use /model to select one.</Text>}
        </>
      ) : null}
    </Box>
  );
}

const app = render(<CliApp />, { exitOnCtrlC: false });
await app.waitUntilExit();
