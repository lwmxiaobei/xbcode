import type { ResponseInputItem, ToolResult, ToolResultDetails, UiBridge } from "../types.js";
import { buildToolRejectionOutput, toolNeedsApproval } from "./tool-approval.js";
import { invalidToolArguments, parseToolArgs, validateToolArgs } from "./tool-args.js";
import { ASK_USER_QUESTION_TOOL_NAME, runAskUserQuestion } from "./user-choice.js";
import type { RunControl, ToolHandlerMap } from "./runtime-types.js";

export type ToolCallExecution = {
  name: string;
  args: Record<string, unknown>;
  output: string;
  details?: ToolResultDetails;
};

// 工具可以只返回一个字符串，也可以返回 { output, details }。
// 这里统一成后者，让调用方不必区分。
function normalizeToolResult(result: string | ToolResult): ToolResult {
  return typeof result === "string" ? { output: result } : result;
}

export async function executeToolCall(
  toolCall: any,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  control?: RunControl,
  requireApproval = false,
): Promise<ToolCallExecution> {
  const name = String(toolCall.name ?? toolCall.function?.name ?? "unknown_tool");
  const rawArgs = String(toolCall.arguments ?? toolCall.function?.arguments ?? "{}");
  const parsed = parseToolArgs(rawArgs);

  if (!parsed.ok) {
    const output = invalidToolArguments(name, parsed.error);
    bridge.pushTool(name, parsed.args, output);
    return { name, args: parsed.args, output };
  }

  const args = parsed.args;
  const validationError = validateToolArgs(name, args);
  if (validationError) {
    bridge.pushTool(name, args, validationError);
    return { name, args, output: validationError };
  }

  if (name === ASK_USER_QUESTION_TOOL_NAME) {
    const output = await runAskUserQuestion(args, bridge);
    bridge.pushTool(name, args, output);
    return { name, args, output };
  }

  if (requireApproval && toolNeedsApproval(name)) {
    const decision = await bridge.requestToolApproval(name, args);
    if (decision === "rejected") {
      const output = buildToolRejectionOutput(name);
      bridge.pushTool(name, args, output);
      return { name, args, output };
    }
  }

  const handler = handlers[name];
  const result = normalizeToolResult(handler ? await handler(args, control) : `Unknown tool: ${name}`);
  bridge.pushTool(name, args, result.output, result.details);
  return { name, args, output: result.output, details: result.details };
}

export async function runToolCall(
  toolCall: any,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  control?: RunControl,
  requireApproval = false,
): Promise<ResponseInputItem> {
  const result = await executeToolCall(toolCall, bridge, handlers, control, requireApproval);

  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: result.output,
  };
}
