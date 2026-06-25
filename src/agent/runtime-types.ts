import type { ToolArgs } from "../types.js";

export type RunControl = {
  signal?: AbortSignal;
};

export type ToolHandler = (args: ToolArgs, control?: RunControl) => Promise<string> | string;
export type ToolHandlerMap = Record<string, ToolHandler>;

export type PreparedToolRuntime = {
  handlers: ToolHandlerMap;
  responseTools: readonly any[];
  chatTools: readonly any[];
};
