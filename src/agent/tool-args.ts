import type { ToolArgs } from "../types.js";

export type ToolArgsParseResult =
  | { ok: true; args: ToolArgs }
  | { ok: false; args: ToolArgs; error: string };

export function parseToolArgs(value: string): ToolArgsParseResult {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, args: {}, error: "expected a JSON object" };
    }
    return { ok: true, args: parsed as ToolArgs };
  } catch {
    return {
      ok: false,
      args: {},
      error: "malformed JSON, possibly truncated by the model or provider; retry with a smaller complete call, and build large files incrementally",
    };
  }
}

export function invalidToolArguments(name: string, reason: string): string {
  return `Error: Invalid arguments for ${name}: ${reason}. The tool was not executed.`;
}

export function validateToolArgs(name: string, args: ToolArgs): string | null {
  if (name !== "write_file") {
    return null;
  }

  if (typeof args.path !== "string" || args.path.trim() === "") {
    return invalidToolArguments(name, "path must be a non-empty string");
  }
  if (typeof args.content !== "string") {
    return invalidToolArguments(name, "content must be a string");
  }
  return null;
}
