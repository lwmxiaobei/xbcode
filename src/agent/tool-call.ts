import type { ResponseInputItem, UiBridge } from "../types.js";
import { buildToolRejectionOutput, toolNeedsApproval } from "./tool-approval.js";
import { safeJsonParse } from "./tool-args.js";
import { ASK_USER_QUESTION_TOOL_NAME, runAskUserQuestion } from "./user-choice.js";
import type { RunControl, ToolHandlerMap } from "./runtime-types.js";

export async function runToolCall(
  toolCall: any,
  bridge: UiBridge,
  handlers: ToolHandlerMap,
  control?: RunControl,
  requireApproval = false,
): Promise<ResponseInputItem> {
  const name = String(toolCall.name ?? toolCall.function?.name ?? "unknown_tool");
  const rawArgs = String(toolCall.arguments ?? toolCall.function?.arguments ?? "{}");
  const args = safeJsonParse(rawArgs);

  if (name === ASK_USER_QUESTION_TOOL_NAME) {
    const output = await runAskUserQuestion(args, bridge);
    bridge.pushTool(name, args, output);
    return {
      type: "function_call_output",
      call_id: toolCall.call_id,
      output,
    };
  }

  if (requireApproval && toolNeedsApproval(name)) {
    const decision = await bridge.requestToolApproval(name, args);
    if (decision === "rejected") {
      const rejection = buildToolRejectionOutput(name);
      bridge.pushTool(name, args, rejection);
      return {
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: rejection,
      };
    }
  }

  const handler = handlers[name];
  const outputText = handler ? await handler(args, control) : `Unknown tool: ${name}`;
  bridge.pushTool(name, args, outputText);

  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: outputText,
  };
}
