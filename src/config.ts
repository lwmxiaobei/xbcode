import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import type { McpServerConfig } from "./mcp/types.js";
import { isPlainRecord } from "./utils.js";

export type ModelEntry = {
  id: string;
  name?: string;
  description?: string;
};

export type ModelProfile = {
  models: (string | ModelEntry)[];
  apiKey?: string;
  baseURL?: string;
  apiMode?: "responses" | "chat-completions";
};

export type Settings = {
  providers: Record<string, ModelProfile>;
  defaultProvider?: string;
  showThinking?: boolean;
  mcp?: {
    servers: McpServerConfig[];
  };
};

export type ResolvedConfig = {
  model: string;
  apiKey: string;
  baseURL: string;
  apiMode: "responses" | "chat-completions";
  showThinking: boolean;
  providerName: string;
  availableModels: string[];
};

const CONFIG_DIR = path.join(os.homedir(), ".codemini");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

let cachedSettings: Settings | null = null;
let cachedSettingsWarnings: string[] = [];

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

export function loadSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  const defaultSettings: Settings = { providers: {}, mcp: { servers: [] } };

  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      cachedSettingsWarnings = [];
      cachedSettings = defaultSettings;
      return defaultSettings;
    }
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const warnings: string[] = [];
    cachedSettings = normalizeSettings(parsed, warnings);
    cachedSettingsWarnings = warnings;
    return cachedSettings!;
  } catch (error) {
    cachedSettingsWarnings = [`[config] Failed to load settings: ${error instanceof Error ? error.message : String(error)}`];
    cachedSettings = defaultSettings;
    return defaultSettings;
  }
}

export function reloadSettings(): Settings {
  cachedSettings = null;
  cachedSettingsWarnings = [];
  return loadSettings();
}

export function getSettingsWarnings(): string[] {
  return [...cachedSettingsWarnings];
}

export function getProviderNames(): string[] {
  const settings = loadSettings();
  return Object.keys(settings.providers);
}

export function normalizeModelEntry(entry: string | ModelEntry): ModelEntry {
  if (typeof entry === "string") return { id: entry };
  return entry;
}

export function getProviderModels(providerName: string): string[] {
  const settings = loadSettings();
  return (settings.providers[providerName]?.models ?? []).map((m) => normalizeModelEntry(m).id);
}

function resolveApiMode(baseURL: string, explicit?: string): "responses" | "chat-completions" {
  const mode = (explicit ?? "").trim().toLowerCase();
  if (["chat", "chat-completions", "chat_completions"].includes(mode)) {
    return "chat-completions";
  }
  if (mode === "responses") {
    return "responses";
  }
  if (baseURL.toLowerCase().includes("deepseek.com")) {
    return "chat-completions";
  }
  return "responses";
}

export function resolveConfig(providerName?: string, modelName?: string): ResolvedConfig {
  const settings = loadSettings();

  // Determine which provider to use: explicit arg > defaultProvider > first available key
  const providerKeys = Object.keys(settings.providers);
  const targetProvider = providerName || settings.defaultProvider || providerKeys[0] || "";
  const provider = settings.providers[targetProvider];

  const availableModels = (provider?.models ?? []).map((m) => normalizeModelEntry(m).id);
  const model = modelName ?? "";
  const apiKey = provider?.apiKey ?? "";
  const baseURL = provider?.baseURL ?? "https://api.openai.com/v1";
  const apiMode = resolveApiMode(baseURL, provider?.apiMode);
  const showThinking = settings.showThinking ?? false;

  return {
    model,
    apiKey,
    baseURL,
    apiMode,
    showThinking,
    providerName: targetProvider,
    availableModels,
  };
}

function normalizeStringRecord(
  value: unknown,
  warningPrefix: string,
  warnings: string[],
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainRecord(value)) {
    warnings.push(`${warningPrefix} must be an object.`);
    return undefined;
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null)
    .map(([key, entryValue]) => [key, String(entryValue)] as const);

  return Object.fromEntries(entries);
}

function normalizeStringArray(
  value: unknown,
  warningPrefix: string,
  warnings: string[],
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    warnings.push(`${warningPrefix} must be an array.`);
    return undefined;
  }

  return value.map((entry) => String(entry));
}

function normalizeMcpServer(
  value: unknown,
  index: number,
  warnings: string[],
  seenNames: Set<string>,
): McpServerConfig | null {
  if (!isPlainRecord(value)) {
    warnings.push(`[mcp] server[${index}] must be an object.`);
    return null;
  }

  const name = String(value.name ?? "").trim();
  if (!name) {
    warnings.push(`[mcp] server[${index}] is missing a non-empty name.`);
    return null;
  }

  if (seenNames.has(name)) {
    warnings.push(`[mcp] duplicate server name "${name}" was ignored.`);
    return null;
  }

  const transport = value.transport === "stdio" || value.transport === "streamable-http"
    ? value.transport
    : null;
  if (!transport) {
    warnings.push(`[mcp] server "${name}" has unsupported transport "${String(value.transport ?? "")}".`);
    return null;
  }

  const timeoutValue = value.timeoutMs;
  const timeoutMs = typeof timeoutValue === "number" && Number.isFinite(timeoutValue) && timeoutValue > 0
    ? timeoutValue
    : 30_000;
  if (timeoutValue !== undefined && timeoutMs !== timeoutValue) {
    warnings.push(`[mcp] server "${name}" has invalid timeoutMs; defaulting to 30000.`);
  }

  const enabled = value.enabled === undefined ? true : Boolean(value.enabled);

  if (transport === "stdio") {
    const command = String(value.command ?? "").trim();
    if (!command) {
      warnings.push(`[mcp] stdio server "${name}" is missing command.`);
      return null;
    }

    const cwd = typeof value.cwd === "string" ? value.cwd.trim() : undefined;
    if (value.cwd !== undefined && typeof value.cwd !== "string") {
      warnings.push(`[mcp] server "${name}".cwd must be a string.`);
    } else if (cwd && !fs.existsSync(cwd)) {
      warnings.push(`[mcp] stdio server "${name}" cwd does not exist: ${cwd}.`);
    }

    seenNames.add(name);
    return {
      name,
      enabled,
      transport,
      command,
      args: normalizeStringArray(value.args, `[mcp] server "${name}".args`, warnings) ?? [],
      env: normalizeStringRecord(value.env, `[mcp] server "${name}".env`, warnings),
      cwd: cwd || undefined,
      timeoutMs,
    };
  }

  const url = String(value.url ?? "").trim();
  if (!url) {
    warnings.push(`[mcp] streamable-http server "${name}" is missing url.`);
    return null;
  }

  seenNames.add(name);
  return {
    name,
    enabled,
    transport,
    url,
    headers: normalizeStringRecord(value.headers, `[mcp] server "${name}".headers`, warnings),
    timeoutMs,
  };
}

function normalizeSettings(raw: unknown, warnings: string[]): Settings {
  const root = isPlainRecord(raw) ? raw : {};

  if (root.providers !== undefined && !isPlainRecord(root.providers)) {
    warnings.push("[config] providers must be an object.");
  }

  const providers = isPlainRecord(root.providers)
    ? (root.providers as Record<string, ModelProfile>)
    : {};

  const mcpRoot = isPlainRecord(root.mcp) ? root.mcp : undefined;
  if (root.mcp !== undefined && !mcpRoot) {
    warnings.push("[mcp] mcp must be an object.");
  }

  const rawServers = mcpRoot?.servers;
  if (rawServers !== undefined && !Array.isArray(rawServers)) {
    warnings.push("[mcp] mcp.servers must be an array.");
  }

  const seenNames = new Set<string>();
  const servers = Array.isArray(rawServers)
    ? rawServers
        .map((value, index) => normalizeMcpServer(value, index, warnings, seenNames))
        .filter((value): value is McpServerConfig => value !== null)
    : [];

  return {
    providers,
    defaultProvider: typeof root.defaultProvider === "string" ? root.defaultProvider : undefined,
    showThinking: typeof root.showThinking === "boolean" ? root.showThinking : undefined,
    mcp: { servers },
  };
}
