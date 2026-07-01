import test from "node:test";
import assert from "node:assert/strict";

import { runToolCall } from "../src/agent/tool-call.js";
import type { ToolArgs, UiBridge } from "../src/types.js";

function createBridge(toolEvents: Array<{ name: string; args: ToolArgs; result: string }>): UiBridge {
  return {
    appendAssistantDelta() {},
    appendThinkingDelta() {},
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool(name, args, result) {
      toolEvents.push({ name, args, result });
    },
    updateUsage() {},
    noteStreamActivity() {},
    requestToolApproval: async () => "approved",
    requestUserChoice: async (questions) => questions.map((question) => [question.options[0]?.label ?? ""]),
  };
}

test("runToolCall rejects malformed JSON without invoking the handler", async () => {
  const events: Array<{ name: string; args: ToolArgs; result: string }> = [];
  let handlerCalls = 0;

  const output = await runToolCall(
    {
      type: "function_call",
      call_id: "call_truncated",
      name: "write_file",
      arguments: "{\"content\":\"truncated",
    },
    createBridge(events),
    {
      write_file: () => {
        handlerCalls += 1;
        return "unexpected";
      },
    },
  );

  assert.equal(handlerCalls, 0);
  assert.match(String(output.output), /^Error: Invalid arguments for write_file: malformed JSON/);
  assert.deepEqual(events, [
    {
      name: "write_file",
      args: {},
      result: output.output as string,
    },
  ]);
});

test("runToolCall still invokes the handler for a complete JSON object", async () => {
  const events: Array<{ name: string; args: ToolArgs; result: string }> = [];
  let receivedArgs: ToolArgs | undefined;

  const output = await runToolCall(
    {
      type: "function_call",
      call_id: "call_valid",
      name: "write_file",
      arguments: "{\"path\":\"docs/a.md\",\"content\":\"hello\"}",
    },
    createBridge(events),
    {
      write_file: (args) => {
        receivedArgs = args;
        return "ok";
      },
    },
  );

  assert.deepEqual(receivedArgs, { path: "docs/a.md", content: "hello" });
  assert.equal(output.output, "ok");
});

test("runToolCall rejects a complete write_file object with a missing path before approval", async () => {
  const events: Array<{ name: string; args: ToolArgs; result: string }> = [];
  let handlerCalls = 0;
  let approvalCalls = 0;
  const bridge = createBridge(events);
  bridge.requestToolApproval = async () => {
    approvalCalls += 1;
    return "approved";
  };

  const output = await runToolCall(
    {
      type: "function_call",
      call_id: "call_missing_path",
      name: "write_file",
      arguments: "{\"content\":\"hello\"}",
    },
    bridge,
    {
      write_file: () => {
        handlerCalls += 1;
        return "unexpected";
      },
    },
    undefined,
    true,
  );

  assert.equal(handlerCalls, 0);
  assert.equal(approvalCalls, 0);
  assert.match(String(output.output), /^Error: Invalid arguments for write_file: path must be a non-empty string/);
});
