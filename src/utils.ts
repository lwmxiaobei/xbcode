import util from "node:util";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ellipsize(text: string, maxLength = 160): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isDebugEnabled(): boolean {
  const value = process.env.DEBUG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function debugLog(...args: unknown[]): void {
  if (!isDebugEnabled()) {
    return;
  }

  const message = args.length > 0 ? util.format(...args) : "";
  process.stderr.write(`[debug] ${message}\n`);
}
