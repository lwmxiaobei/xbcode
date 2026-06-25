import type { ToolArgs } from "../types.js";

export function safeJsonParse(value: string): ToolArgs {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
