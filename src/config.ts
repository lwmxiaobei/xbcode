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
  auth?: ProviderAuthConfig;
};

export type ProviderAuthConfig = {
  type: "oauth";
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

export type StoredOAuthCredentials = {
  type: "oauth";
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: string;
  client_id?: string;
  email?: string;
  chatgpt_account_id?: string;
};

export type CredentialsFile = {
  providers: Record<string, StoredOAuthCredentials>;
};

export type ProviderAuthState = {
  authMode: "oauth" | "apiKey" | "none";
  bearerToken: string;
  apiKey: string;
  oauth?: StoredOAuthCredentials;
};

export type RuntimeAuthResolution = {
  state: ProviderAuthState;
  credentials: CredentialsFile;
  didRefresh: boolean;
};

export type ResolveRuntimeAuthArgs = {
  settings: Settings;
  providerName: string;
  credentials?: CredentialsFile;
  refreshOAuthToken?: (credentials: StoredOAuthCredentials) => Promise<StoredOAuthCredentials>;
  onCredentialsUpdated?: (credentials: CredentialsFile) => Promise<void> | void;
  now?: Date;
};

const CONFIG_DIR = path.join(os.homedir(), ".xbcode");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");

let cachedSettings: Settings | null = null;
let cachedSettingsWarnings: string[] = [];

export function getSettingsPath(): string {
  return SETTINGS_PATH;
}

export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
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

/**
 * Read and normalize a settings file from an explicit path.
 *
 * Why this exists:
 * - Most runtime code uses the global settings path, but targeted update helpers
 *   and tests need the same normalization behavior for arbitrary files.
 * - Keeping the file-path variant local to this module avoids exposing another
 *   caching surface while still reusing the exact same parser rules.
 */
function loadSettingsFromFile(filePath: string): Settings {
  const defaultSettings: Settings = { providers: {}, mcp: { servers: [] } };

  try {
    if (!fs.existsSync(filePath)) {
      return defaultSettings;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeSettings(JSON.parse(raw), []);
  } catch {
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

export function loadCredentialsFile(filePath = CREDENTIALS_PATH): CredentialsFile {
  const empty: CredentialsFile = { providers: {} };
  try {
    if (!fs.existsSync(filePath)) {
      return empty;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeCredentialsFile(raw);
  } catch {
    return empty;
  }
}

export async function writeCredentialsFile(filePath: string, credentials: CredentialsFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(normalizeCredentialsFile(credentials), null, 2)}\n`, "utf8");
}

/**
 * Persist normalized settings back to disk.
 *
 * Why this exists:
 * - Runtime flows such as OAuth model discovery need to update the user's
 *   provider configuration after the process has already started.
 * - Writing normalized settings keeps the stored file aligned with the same
 *   schema validation rules used during reads, which avoids persisting partial
 *   or malformed provider state.
 * - Resetting the cache after the write ensures later reads in the same process
 *   see the new configuration immediately.
 */
export async function writeSettingsFile(filePath: string, settings: Settings): Promise<void> {
  const normalized = normalizeSettings(settings, []);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  cachedSettings = null;
  cachedSettingsWarnings = [];
}

/**
 * Update the model list for a single provider while preserving the rest of the
 * settings file as-is.
 *
 * Why this exists:
 * - OAuth login can discover the exact API-visible model IDs for the active
 *   provider and should write only that slice of configuration.
 * - Reusing a focused helper keeps the login flow small and avoids duplicating
 *   settings-file merge logic in UI code.
 * - The helper normalizes incoming model IDs so callers can pass any raw API
 *   list without worrying about duplicate whitespace or empty entries.
 */
export async function updateProviderModels(filePath: string, providerName: string, modelIds: string[]): Promise<void> {
  const settings = loadSettingsFromFile(filePath);
  const provider = settings.providers[providerName];
  if (!provider) {
    return;
  }

  const normalizedModels = modelIds
    .map((modelId) => modelId.trim())
    .filter((modelId, index, values) => Boolean(modelId) && values.indexOf(modelId) === index);

  await writeSettingsFile(filePath, {
    ...settings,
    providers: {
      ...settings.providers,
      [providerName]: {
        ...provider,
        models: normalizedModels,
      },
    },
  });
}

export async function clearProviderCredentials(filePath: string, providerName: string): Promise<void> {
  const current = loadCredentialsFile(filePath);
  if (!(providerName in current.providers)) {
    return;
  }
  const nextProviders = { ...current.providers };
  delete nextProviders[providerName];
  await writeCredentialsFile(filePath, { providers: nextProviders });
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

function normalizeAuthConfig(
  value: unknown,
  warningPrefix: string,
  warnings: string[],
): ProviderAuthConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainRecord(value)) {
    warnings.push(`${warningPrefix} must be an object.`);
    return undefined;
  }

  if (value.type === "oauth") {
    return { type: "oauth" };
  }

  warnings.push(`${warningPrefix}.type must be "oauth".`);
  return undefined;
}

function normalizeModelProfile(
  value: unknown,
  providerName: string,
  warnings: string[],
): ModelProfile | null {
  if (!isPlainRecord(value)) {
    warnings.push(`[config] provider "${providerName}" must be an object.`);
    return null;
  }

  const models = Array.isArray(value.models) ? value.models : [];
  if (!Array.isArray(value.models)) {
    warnings.push(`[config] provider "${providerName}".models must be an array.`);
  }

  const normalizedModels: (string | ModelEntry)[] = [];
  for (const entry of models) {
    if (typeof entry === "string") {
      normalizedModels.push(entry);
      continue;
    }
    if (isPlainRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
      normalizedModels.push({
        id: entry.id.trim(),
        name: typeof entry.name === "string" ? entry.name : undefined,
        description: typeof entry.description === "string" ? entry.description : undefined,
      });
      continue;
    }
    warnings.push(`[config] provider "${providerName}" has an invalid model entry.`);
  }

  return {
    models: normalizedModels,
    apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
    baseURL: typeof value.baseURL === "string" ? value.baseURL : undefined,
    apiMode: value.apiMode === "responses" || value.apiMode === "chat-completions"
      ? value.apiMode
      : undefined,
    auth: normalizeAuthConfig(value.auth, `[config] provider "${providerName}".auth`, warnings),
  };
}

function normalizeStoredOAuthCredentials(value: unknown): StoredOAuthCredentials | null {
  if (!isPlainRecord(value) || value.type !== "oauth") {
    return null;
  }

  return {
    type: "oauth",
    access_token: typeof value.access_token === "string" ? value.access_token : undefined,
    refresh_token: typeof value.refresh_token === "string" ? value.refresh_token : undefined,
    id_token: typeof value.id_token === "string" ? value.id_token : undefined,
    expires_at: typeof value.expires_at === "string" ? value.expires_at : undefined,
    client_id: typeof value.client_id === "string" ? value.client_id : undefined,
    email: typeof value.email === "string" ? value.email : undefined,
    chatgpt_account_id: typeof value.chatgpt_account_id === "string" ? value.chatgpt_account_id : undefined,
  };
}

export function normalizeCredentialsFile(raw: unknown): CredentialsFile {
  if (!isPlainRecord(raw) || !isPlainRecord(raw.providers)) {
    return { providers: {} };
  }

  const providers = Object.entries(raw.providers)
    .map(([providerName, value]) => [providerName, normalizeStoredOAuthCredentials(value)] as const)
    .filter((entry): entry is readonly [string, StoredOAuthCredentials] => entry[1] !== null);

  return { providers: Object.fromEntries(providers) };
}

function isCredentialExpired(value: string | undefined, now = new Date()): boolean {
  if (!value) {
    return false;
  }
  const expiresAt = Date.parse(value);
  if (Number.isNaN(expiresAt)) {
    return false;
  }
  return expiresAt - now.getTime() <= 60_000;
}

export function resolveProviderAuthState(
  settings: Settings,
  providerName: string,
  credentials: CredentialsFile,
  now = new Date(),
): ProviderAuthState {
  const provider = settings.providers[providerName];
  const apiKey = provider?.apiKey ?? "";
  const oauth = credentials.providers[providerName];

  if (provider?.auth?.type === "oauth" && oauth?.type === "oauth") {
    const accessToken = oauth.access_token?.trim() ?? "";
    if (accessToken && !isCredentialExpired(oauth.expires_at, now)) {
      return {
        authMode: "oauth",
        bearerToken: accessToken,
        apiKey,
        oauth,
      };
    }
  }

  if (apiKey.trim()) {
    return {
      authMode: "apiKey",
      bearerToken: apiKey,
      apiKey,
      oauth,
    };
  }

  return {
    authMode: "none",
    bearerToken: "",
    apiKey,
    oauth,
  };
}

export async function resolveRuntimeAuth({
  settings,
  providerName,
  credentials = loadCredentialsFile(),
  refreshOAuthToken,
  onCredentialsUpdated,
  now = new Date(),
}: ResolveRuntimeAuthArgs): Promise<RuntimeAuthResolution> {
  const provider = settings.providers[providerName];
  const oauth = credentials.providers[providerName];
  const initialState = resolveProviderAuthState(settings, providerName, credentials, now);

  if (provider?.auth?.type !== "oauth" || oauth?.type !== "oauth" || !refreshOAuthToken) {
    return { state: initialState, credentials, didRefresh: false };
  }

  const accessToken = oauth.access_token?.trim() ?? "";
  if (accessToken && !isCredentialExpired(oauth.expires_at, now)) {
    return { state: initialState, credentials, didRefresh: false };
  }

  const refreshToken = oauth.refresh_token?.trim() ?? "";
  if (!refreshToken) {
    return { state: initialState, credentials, didRefresh: false };
  }

  try {
    const refreshed = await refreshOAuthToken(oauth);
    const nextCredentials: CredentialsFile = {
      providers: {
        ...credentials.providers,
        [providerName]: refreshed,
      },
    };
    if (onCredentialsUpdated) {
      await onCredentialsUpdated(nextCredentials);
    }
    return {
      state: resolveProviderAuthState(settings, providerName, nextCredentials, now),
      credentials: nextCredentials,
      didRefresh: true,
    };
  } catch {
    return { state: initialState, credentials, didRefresh: false };
  }
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

export function normalizeSettings(raw: unknown, warnings: string[]): Settings {
  const root = isPlainRecord(raw) ? raw : {};

  if (root.providers !== undefined && !isPlainRecord(root.providers)) {
    warnings.push("[config] providers must be an object.");
  }

  const providers = isPlainRecord(root.providers)
    ? Object.fromEntries(
        Object.entries(root.providers)
          .map(([providerName, value]) => [providerName, normalizeModelProfile(value, providerName, warnings)] as const)
          .filter((entry): entry is readonly [string, ModelProfile] => entry[1] !== null),
      )
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
