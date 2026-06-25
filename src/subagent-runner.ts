import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type OpenAI from "openai";

import { buildAgentClient } from "./agent-client.js";
import {
  getCredentialsPath,
  loadCredentialsFile,
  loadSettings,
  resolveConfig,
  resolveRuntimeAuth,
  writeCredentialsFile,
} from "./config.js";
import { refreshAccessToken } from "./oauth/openai.js";
import { getSubagentDefinition, type SubagentDefinition } from "./subagents.js";
import { BASE_CHAT_TOOLS, BASE_TOOLS, BASE_TOOL_HANDLERS } from "./tools.js";
import { extractAssistantText } from "./agent/messages.js";
import type { PreparedToolRuntime, ToolHandlerMap } from "./agent/runtime-types.js";
import { streamChatCompletion, streamResponse } from "./agent/streams.js";
import { runToolCall } from "./agent/tool-call.js";
import { safeJsonParse } from "./agent/tool-args.js";
import type {
  ChatMessage,
  ResponseInputItem,
  ToolApprovalDecision,
  UiBridge,
  UserChoiceQuestion,
} from "./types.js";

// CLI sentinel: the child process is the runner file itself re-invoked with
// this flag. When the parent merely imports this module (to call
// dispatchSubagent / getSubagentInvocation), its argv lacks the flag, so the
// bottom-of-file guard stays inert.
const SUBAGENT_FLAG = "__subagent";

/**
 * Spec handed to the child over stdin.
 *
 * The base `system` prompt is forwarded verbatim so the child does not have to
 * re-initialize skills/MCP just to rebuild it; `providerName`/`modelName` let
 * the child re-resolve auth from persisted credentials in its own process.
 */
export type SubagentSpec = {
  subagentType?: string;
  description: string;
  system: string;
  providerName: string;
  modelName: string;
};

type SubagentEvent =
  | { type: "tool"; name: string; args: unknown; output: string }
  | { type: "result"; text: string }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Tool runtime (moved out of agent.ts so the child needs no Ink entrypoint).
// ---------------------------------------------------------------------------

// 子代理需要按定义裁剪工具，而不是总是继承整套 BASE_TOOLS。
function selectToolsByName(tools: readonly any[], allowedToolNames: readonly string[]): any[] {
  const allowed = new Set(allowedToolNames);
  return tools.filter((tool) => allowed.has(String(tool?.name ?? "")));
}

// `explore` 这类只读 agent 不能直接复用通用 bash handler。这里做一层显式白名单，
// 把“只读”从 prompt 约束升级为运行时约束，避免模型失手写文件。
function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }

  const forbiddenPatterns = [
    /(^|[\s;&|])(rm|mv|cp|mkdir|touch|chmod|chown)\b/,
    /(^|[\s;&|])(git\s+(add|commit|checkout|switch|restore|reset|clean|merge|rebase|pull|push))\b/,
    /(^|[\s;&|])(npm|pnpm|yarn|bun|pip|pip3)\s+(install|add|remove|uninstall)\b/,
    />/,
    /\|/,
  ];

  return !forbiddenPatterns.some((pattern) => pattern.test(trimmed));
}

// 这里把“工具列表”和“工具执行函数”一起裁剪。
function buildSubagentRuntime(definition: SubagentDefinition): PreparedToolRuntime {
  const responseTools = selectToolsByName(BASE_TOOLS, definition.allowedTools);
  const chatTools = selectToolsByName(BASE_CHAT_TOOLS, definition.allowedTools);
  const handlers: ToolHandlerMap = { ...BASE_TOOL_HANDLERS };

  if (definition.readOnlyShell) {
    handlers.bash = ({ command }) => {
      const normalized = String(command ?? "");
      if (!isReadOnlyShellCommand(normalized)) {
        return "Error: This sub-agent is read-only. Only non-mutating shell commands are allowed.";
      }
      return BASE_TOOL_HANDLERS.bash({ command: normalized });
    };
  }

  for (const toolName of Object.keys(handlers)) {
    if (!definition.allowedTools.includes(toolName)) {
      delete handlers[toolName];
    }
  }

  return { handlers, responseTools, chatTools };
}

async function subAgentLoopResponses(
  client: OpenAI,
  model: string,
  system: string,
  description: string,
  bridge: UiBridge,
  definition: SubagentDefinition,
): Promise<string> {
  const runtime = buildSubagentRuntime(definition);
  let nextInput: ResponseInputItem[] | string = [
    { role: "user", content: [{ type: "input_text", text: description }] },
  ];
  let currentResponseId: string | undefined;
  let lastText = "";

  const caller = `subagent:${definition.name}`;
  for (let round = 0; round < definition.maxRounds; round += 1) {
    const response = await streamResponse(client, model, system, false, nextInput, currentResponseId, bridge, runtime.responseTools, undefined, undefined, caller);
    currentResponseId = response.id;

    const textItems = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "message" || item.type === "text")
      : [];
    for (const item of textItems) {
      const text = extractAssistantText(item.content ?? item.text ?? "");
      if (text.trim()) lastText = text.trim();
    }

    const outputText = Array.isArray(response.output)
      ? response.output
          .map((item: any) => {
            if (item.type === "message") return extractAssistantText(item.content);
            return "";
          })
          .join("")
          .trim()
      : "";
    if (outputText) lastText = outputText;

    const toolCalls = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "function_call")
      : [];

    if (toolCalls.length === 0) break;

    const results: ResponseInputItem[] = [];
    for (const toolCall of toolCalls) {
      results.push(await runToolCall(toolCall, bridge, runtime.handlers));
    }
    nextInput = results;
  }

  return lastText || "(sub-agent completed with no text output)";
}

async function subAgentLoopChatCompletions(
  client: OpenAI,
  model: string,
  system: string,
  description: string,
  bridge: UiBridge,
  definition: SubagentDefinition,
): Promise<string> {
  const runtime = buildSubagentRuntime(definition);
  const history: ChatMessage[] = [{ role: "user", content: description }];
  let lastText = "";

  const caller = `subagent:${definition.name}`;
  for (let round = 0; round < definition.maxRounds; round += 1) {
    const message = await streamChatCompletion(client, model, system, history, bridge, runtime.chatTools, false, undefined, undefined, caller);

    const assistantText = extractAssistantText(message.content);
    if (assistantText.trim()) {
      lastText = assistantText.trim();
    }

    history.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls.length > 0 ? message.tool_calls : undefined,
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });

    const toolCalls = message.tool_calls;
    if (toolCalls.length === 0) break;

    for (const toolCall of toolCalls) {
      const name = String(toolCall.function?.name ?? "unknown_tool");
      const args = safeJsonParse(String(toolCall.function?.arguments ?? "{}"));
      const handler = runtime.handlers[name];
      const outputText = handler ? await handler(args) : `Unknown tool: ${name}`;
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });
    }
  }

  return lastText || "(sub-agent completed with no text output)";
}

// ---------------------------------------------------------------------------
// Parent side: spawn the child and bridge its JSONL stream into the UI.
// ---------------------------------------------------------------------------

/**
 * Resolve how to re-invoke this runner file as a child process.
 *
 * Mirrors pi's getPiInvocation: re-run the same module under the current
 * runtime. In dev the file is `.ts` and must go through the tsx loader; once
 * compiled it is a plain `.js` run by node directly.
 */
export function getSubagentInvocation(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith(".ts") || here.endsWith(".tsx");
  if (isTs) {
    return { command: process.execPath, args: ["--import", "tsx", here, SUBAGENT_FLAG] };
  }
  return { command: process.execPath, args: [here, SUBAGENT_FLAG] };
}

/**
 * Dispatch a sub-agent task to an isolated OS process and return its final
 * summary. Tool events stream back over JSONL and are forwarded to the parent
 * UI so the user still sees the sub-agent's tool activity live.
 */
export function dispatchSubagent(spec: SubagentSpec, bridge: UiBridge): Promise<string> {
  const { command, args } = getSubagentInvocation();

  return new Promise<string>((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    let buffer = "";
    let finalText = "";
    let errorText = "";
    let stderr = "";

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let event: SubagentEvent;
      try {
        event = JSON.parse(line) as SubagentEvent;
      } catch {
        return;
      }
      if (event.type === "tool") {
        bridge.pushTool(String(event.name), (event.args ?? {}) as Record<string, unknown>, String(event.output ?? ""));
      } else if (event.type === "result") {
        finalText = String(event.text ?? "");
      } else if (event.type === "error") {
        errorText = String(event.message ?? "");
      }
    };

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        handleLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      resolve(`Sub-agent failed to start: ${err.message}`);
    });

    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer);
      if (errorText) {
        resolve(`Sub-agent error: ${errorText}`);
        return;
      }
      if (finalText) {
        resolve(finalText);
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim();
        resolve(`Sub-agent exited with code ${code}${detail ? `: ${detail.slice(0, 2000)}` : ""}`);
        return;
      }
      resolve("(sub-agent completed with no text output)");
    });

    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Child side: read the spec, run the loop, emit JSONL to stdout.
// ---------------------------------------------------------------------------

function emit(event: SubagentEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// 子进程无人可交互：工具自动通过，问题取首选项作为确定性默认答案。
// 工具调用通过 JSONL 转发给父进程展示；流式文本增量在此被丢弃。
function createJsonlBridge(): UiBridge {
  return {
    appendAssistantDelta() {},
    appendThinkingDelta() {},
    finalizeStreaming() {},
    pushAssistant() {},
    pushTool(name: string, args: Record<string, unknown>, output: string) {
      emit({ type: "tool", name, args, output });
    },
    updateUsage() {},
    noteStreamActivity() {},
    requestToolApproval() {
      return Promise.resolve<ToolApprovalDecision>("approved");
    },
    requestUserChoice(questions: UserChoiceQuestion[]) {
      return Promise.resolve(
        questions.map((question) => (question.options[0] ? [question.options[0].label] : [])),
      );
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runSubagentHeadless(): Promise<number> {
  try {
    const raw = await readStdin();
    const spec = JSON.parse(raw) as SubagentSpec;

    const resolved = resolveConfig(spec.providerName, spec.modelName);
    const settings = loadSettings();
    const authResult = await resolveRuntimeAuth({
      settings,
      providerName: resolved.providerName,
      credentials: loadCredentialsFile(getCredentialsPath()),
      refreshOAuthToken: async (credentials) =>
        refreshAccessToken({
          clientId: credentials.client_id,
          refreshToken: credentials.refresh_token ?? "",
        }),
      onCredentialsUpdated: async (credentials) => {
        await writeCredentialsFile(getCredentialsPath(), credentials);
      },
    });

    const { client } = buildAgentClient(resolved, authResult.state);
    const definition = getSubagentDefinition(spec.subagentType);
    const subSystem = `${spec.system}\n${definition.systemPrompt}`;
    const bridge = createJsonlBridge();

    const result = resolved.apiMode === "chat-completions"
      ? await subAgentLoopChatCompletions(client, resolved.model, subSystem, spec.description, bridge, definition)
      : await subAgentLoopResponses(client, resolved.model, subSystem, spec.description, bridge, definition);

    emit({ type: "result", text: result });
    return 0;
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
    return 1;
  }
}

// Entry guard: only fires when this file is run as the spawned child.
if (process.argv.includes(SUBAGENT_FLAG)) {
  void runSubagentHeadless().then((code) => {
    process.exit(code);
  });
}
