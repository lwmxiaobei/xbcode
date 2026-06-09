import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = path.join(os.homedir(), ".xbcode");
const LOG_PATH = path.join(LOG_DIR, "error.log");

export type ApiCaller = string;

export type ApiRequestSummary = {
  api: "responses" | "chat-completions" | "autoCompact" | "autoCompactResponseHistory";
  model?: string;
  previousResponseId?: string;
  toolCount?: number;
  inputItemCount?: number;
  inputCharCount?: number;
  showThinking?: boolean;
  [key: string]: any;
};

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Best-effort; logging must never crash the agent.
  }
}

function pickHeader(headers: unknown, key: string): string | undefined {
  if (!headers) return undefined;
  // OpenAI SDK exposes headers as a plain object on APIError.
  const record = headers as Record<string, unknown>;
  const value = record[key] ?? record[key.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function sanitizeForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, seen));
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sanitizeForLog(item, seen);
  }
  return output;
}

function compactStack(stack: unknown): string | undefined {
  if (typeof stack !== "string" || !stack.trim()) {
    return undefined;
  }
  return stack.split("\n").slice(0, 12).join("\n");
}

export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }
  const err = error as Record<string, unknown> & {
    message?: string;
    status?: number;
    headers?: unknown;
    error?: unknown;
    cause?: unknown;
    code?: unknown;
    stack?: unknown;
  };
  const result: Record<string, unknown> = {
    name: (err as { name?: string }).name,
    message: err.message,
    code: typeof err.code === "string" ? err.code : undefined,
    status: err.status,
    requestId: pickHeader(err.headers, "x-request-id"),
    body: sanitizeForLog(err.error),
    stack: compactStack(err.stack),
  };
  if (err.cause !== undefined) {
    result.cause = depth >= 4
      ? { message: "Cause depth limit reached." }
      : describeError(err.cause, depth + 1);
  }
  return result;
}

/**
 * Append a structured JSON record to ~/.xbcode/error.log.
 *
 * Why a file (not stderr): when the user sees a 400 in the TUI we want a
 * forensic trail to grep through after the fact, including which agent (main /
 * subagent:<name> / teammate:<name>) made the failing request.
 */
export function logApiError(
  caller: ApiCaller,
  error: unknown,
  request: ApiRequestSummary,
): void {
  ensureLogDir();
  const record = {
    ts: new Date().toISOString(),
    caller,
    request,
    error: describeError(error),
  };
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Best-effort.
  }
}

/**
 * Wrap an API error so the message carries the caller tag. Preserves the
 * original error via `cause` and copies status/headers so downstream retry /
 * abort checks (e.g. isTransientNetworkError) still work.
 */
export function wrapApiError(caller: ApiCaller, error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`[${caller}] ${String(error)}`);
  }
  const wrapped = new Error(`[${caller}] ${error.message}`, { cause: error });
  wrapped.name = error.name;
  const src = error as Error & { status?: number; headers?: unknown; error?: unknown };
  const dst = wrapped as Error & { status?: number; headers?: unknown; error?: unknown };
  if (src.status !== undefined) dst.status = src.status;
  if (src.headers !== undefined) dst.headers = src.headers;
  if (src.error !== undefined) dst.error = src.error;
  return wrapped;
}

export function getErrorLogPath(): string {
  return LOG_PATH;
}
