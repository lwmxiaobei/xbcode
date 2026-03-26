import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

export function loadSettings(): Settings {
  if (cachedSettings) return cachedSettings;

  const defaultSettings: Settings = { providers: {} };

  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      cachedSettings = defaultSettings;
      return defaultSettings;
    }
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cachedSettings = { providers: {}, ...parsed };
    return cachedSettings!;
  } catch {
    cachedSettings = defaultSettings;
    return defaultSettings;
  }
}

export function reloadSettings(): Settings {
  cachedSettings = null;
  return loadSettings();
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

