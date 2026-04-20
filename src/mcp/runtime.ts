import { getSettingsWarnings, loadSettings, reloadSettings } from "../config.js";
import { type McpGetPromptResult, type McpReadResourceResult, type McpToolCallResult } from "./client.js";
import { McpManager } from "./manager.js";
import { McpRuntimeError, type McpCallArgs } from "./types.js";
import type { ToolArgs } from "../types.js";
import { isPlainRecord } from "../utils.js";

const OUTPUT_LIMIT = 50_000;
const DYNAMIC_MCP_TOOL_NAME_LIMIT = 64;

type DynamicMcpResponseTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type DynamicMcpChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type DynamicMcpToolSurface = {
  responseTools: readonly DynamicMcpResponseTool[];
  chatTools: readonly DynamicMcpChatTool[];
  handlers: Record<string, (args: ToolArgs, control?: { signal?: AbortSignal }) => Promise<string>>;
};

// 运行时只维护一个全局 McpManager，供工具调用和命令共享。
export const mcpManager = new McpManager();

// 初始化过程可能被多个并发调用触发，这里用 promise 去重。
let initializePromise: Promise<McpManager> | null = null;

// 把基础标量类型稳定转成字符串；复杂对象交给 JSON 格式化处理。
function stringifyScalar(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (value === undefined || value === null) {
    return "";
  }
  return formatJson(value);
}

// 工具参数里的 server/kind/name/uri 理论上都应是字符串，这里统一做裁剪和兜底转换。
function normalizeStringInput(value: unknown): string {
  return stringifyScalar(value).trim();
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function sanitizeDynamicToolSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");

  return sanitized || "tool";
}

function buildDynamicToolName(server: string, tool: string): string {
  const readable = `mcp__${sanitizeDynamicToolSegment(server)}__${sanitizeDynamicToolSegment(tool)}`;
  const trimmed = readable.slice(0, DYNAMIC_MCP_TOOL_NAME_LIMIT).replaceAll(/_+$/g, "") || "mcp";
  return trimmed;
}

function normalizeDynamicToolSchema(schema?: Record<string, unknown>): Record<string, unknown> {
  if (!schema) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }

  if (schema.type === undefined) {
    return {
      type: "object",
      ...schema,
    };
  }

  return schema;
}

function buildDynamicToolDescription(server: string, tool: string, description?: string): string {
  const prefix = `MCP tool "${tool}" from server "${server}".`;
  const suffix = description?.trim();
  return suffix ? `${prefix} ${suffix}` : prefix;
}

function ensureUniqueDynamicToolName(name: string, usedNames: Set<string>, server: string, tool: string): string {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }

  const hash = stableHash(`${server}\u0000${tool}`);
  const maxBaseLength = Math.max(1, DYNAMIC_MCP_TOOL_NAME_LIMIT - hash.length - 2);
  const trimmed = name.slice(0, maxBaseLength).replaceAll(/_+$/g, "") || "mcp";
  const fallback = `${trimmed}__${hash}`;
  usedNames.add(fallback);
  return fallback;
}

// 限制最终字符串输出长度，避免工具结果把上下文窗口塞满。
function limitText(text: string, maxLength = OUTPUT_LIMIT): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 30))}\n... (truncated)`;
}

// 统一 JSON 格式化入口；遇到循环引用等情况时退化成普通字符串。
function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// 资源内容既可能是纯文本，也可能是 base64 二进制，这里统一转成人类可读文本。
function formatEmbeddedResource(resource: any): string {
  const mime = resource?.mimeType ? ` (${resource.mimeType})` : "";
  if (typeof resource?.text === "string") {
    return `resource ${resource.uri}${mime}\n${resource.text}`;
  }
  if (typeof resource?.blob === "string") {
    return `resource ${resource?.uri ?? "(unknown)"}${mime}\n[binary data: ${resource.blob.length} base64 chars]`;
  }
  return formatJson(resource);
}

// MCP content item 是一个联合类型，这里把不同类型收敛到统一字符串表示。
function formatContentItem(item: any): string {
  switch (item?.type) {
    case "text":
      return String(item.text ?? "");
    case "image":
      return `[image ${item.mimeType ?? "unknown"}, ${String(item.data ?? "").length} base64 chars]`;
    case "audio":
      return `[audio ${item.mimeType ?? "unknown"}, ${String(item.data ?? "").length} base64 chars]`;
    case "resource":
      return formatEmbeddedResource(item.resource);
    case "resource_link": {
      const description = item.description ? `\n${item.description}` : "";
      return `resource link: ${item.name ?? "(unnamed)"} -> ${item.uri ?? "(unknown)"}${description}`;
    }
    default:
      return formatJson(item);
  }
}

// 把 content 列表拼成统一文本块，空内容时返回 undefined 让上层省略该段。
function formatContentList(items: any[]): string | undefined {
  const parts = items
    .map((item) => formatContentItem(item).trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return undefined;
  }

  return `content:\n${parts.join("\n\n")}`;
}

function formatSchemaSummary(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${formatSchemaSummary(value[0])}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
    const suffix = Object.keys(value as Record<string, unknown>).length > entries.length ? ", ..." : "";
    return `{${entries.map(([key, item]) => `${key}: ${formatSchemaSummary(item)}`).join(", ")}${suffix}}`;
  }
  return typeof value;
}

// tool 调用结果通常最复杂，可能同时带 content、structuredContent、toolResult 和 _meta。
function formatToolResult(server: string, name: string, result: McpToolCallResult): string {
  const lines = [
    `server: ${server}`,
    "kind: tool",
    `tool: ${name}`,
  ];

  if ("isError" in result) {
    lines.push(`status: ${result.isError ? "error" : "ok"}`);
  }

  if ("content" in result && Array.isArray(result.content)) {
    const content = formatContentList(result.content);
    if (content) {
      lines.push("", content);
    }
  }

  if ("structuredContent" in result && result.structuredContent !== undefined) {
    lines.push("", `structuredContent (${formatSchemaSummary(result.structuredContent)}):`, formatJson(result.structuredContent));
  }

  if ("toolResult" in result && result.toolResult !== undefined) {
    lines.push("", `toolResult (${formatSchemaSummary(result.toolResult)}):`, formatJson(result.toolResult));
  }

  if (result._meta) {
    lines.push("", "_meta:", formatJson(result._meta));
  }

  return limitText(lines.join("\n"));
}

// resource 读取结果可能返回多个内容块，这里逐个展开。
function formatReadResourceResult(server: string, uri: string, result: McpReadResourceResult): string {
  const lines = [
    `server: ${server}`,
    "kind: resource",
    `uri: ${uri}`,
  ];

  const contents = result.contents
    .map((content) => formatEmbeddedResource(content).trim())
    .filter(Boolean);

  if (contents.length > 0) {
    lines.push("", "contents:", contents.join("\n\n"));
  }

  if (result._meta) {
    lines.push("", "_meta:", formatJson(result._meta));
  }

  return limitText(lines.join("\n"));
}

// prompt 结果本质上是一组 role + content 的消息，用文本视图展开便于模型继续消费。
function formatPromptResult(server: string, name: string, result: McpGetPromptResult): string {
  const lines = [
    `server: ${server}`,
    "kind: prompt",
    `prompt: ${name}`,
  ];

  if (result.description) {
    lines.push(`description: ${result.description}`);
  }

  if (Array.isArray(result.messages) && result.messages.length > 0) {
    lines.push("", "messages:");
    for (const message of result.messages) {
      lines.push(`[${message.role}]`, formatContentItem(message.content), "");
    }
    if (lines.at(-1) === "") {
      lines.pop();
    }
  }

  if (result._meta) {
    lines.push("", "_meta:", formatJson(result._meta));
  }

  return limitText(lines.join("\n"));
}

function formatResourceList(server: string | undefined): string {
  const items = mcpManager.listResourceDefinitions(server);
  const lines = [
    `kind: resource_list`,
    `scope: ${server ?? "all"}`,
    `count: ${items.length}`,
  ];

  if (items.length === 0) {
    lines.push("", "(no resources found)");
    return lines.join("\n");
  }

  lines.push("", "resources:");
  for (const item of items) {
    const mime = item.mimeType ? ` mime=${item.mimeType}` : "";
    const description = item.description ? `\n  description: ${item.description}` : "";
    lines.push(`- [${item.server}] ${item.name} -> ${item.uri}${mime}${description}`);
  }

  return limitText(lines.join("\n"));
}

async function handleDynamicMcpToolCall(server: string, name: string, args: ToolArgs): Promise<string> {
  try {
    await ensureMcpInitialized();
    if (!isPlainRecord(args)) {
      throw new McpRuntimeError("invalid_arguments", `MCP tool "${name}" arguments must be an object.`);
    }

    const result = await mcpManager.callTool(server, name, args);
    return formatToolResult(server, name, result);
  } catch (error) {
    return formatRuntimeError(error);
  }
}

// MCP prompt 的参数要求是 string map；外部传入 unknown 时需要先做归一化。
function normalizePromptArguments(args?: Record<string, unknown>): Record<string, string> | undefined {
  if (!args || Object.keys(args).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value === "string") {
        return [key, value];
      }
      if (value === undefined || value === null) {
        return [key, ""];
      }
      if (typeof value === "object") {
        return [key, formatJson(value)];
      }
      return [key, stringifyScalar(value)];
    }),
  );
}

// 对外统一错误字符串格式，避免底层异常对象直接泄漏给工具层。
function formatRuntimeError(error: unknown): string {
  if (error instanceof McpRuntimeError) {
    return `Error: [${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${stringifyScalar(error) || "Unknown error"}`;
}

// 对 mcp_call 的工具参数做严格校验，尽量在发请求前就拦住明显错误。
function validateMcpCallArgs(args: ToolArgs): McpCallArgs {
  const server = normalizeStringInput(args.server);
  const kind = normalizeStringInput(args.kind);
  const name = normalizeStringInput(args.name);

  if (!server) {
    throw new McpRuntimeError("invalid_arguments", "mcp_call requires a non-empty server.");
  }

  if (kind !== "prompt") {
    throw new McpRuntimeError(
      "invalid_arguments",
      `mcp_call kind must be "prompt". Received "${kind || "(empty)"}".`,
    );
  }

  if (args.arguments !== undefined && !isPlainRecord(args.arguments)) {
    throw new McpRuntimeError("invalid_arguments", "mcp_call arguments must be an object when provided.");
  }

  if (!name) {
    throw new McpRuntimeError("invalid_arguments", "mcp_call kind=prompt requires name.");
  }

  return {
    server,
    kind: "prompt",
    name: name || undefined,
    arguments: args.arguments as Record<string, unknown> | undefined,
  };
}

// 从配置系统同步 MCP 设置，并按需决定是否立刻初始化连接。
async function syncFromSettings(options?: { reload?: boolean; initialize?: boolean }): Promise<McpManager> {
  const settings = options?.reload ? reloadSettings() : loadSettings();
  const warnings = getSettingsWarnings().filter((warning) => warning.startsWith("[mcp]"));

  await mcpManager.configure(settings.mcp?.servers ?? [], warnings);
  if (options?.initialize) {
    await mcpManager.initializeAll();
  }
  return mcpManager;
}

// 确保 MCP 至少初始化一次；并发场景下复用同一个初始化 promise。
export async function ensureMcpInitialized(): Promise<McpManager> {
  if (mcpManager.isInitialized()) {
    return mcpManager;
  }

  initializePromise ??= syncFromSettings({ initialize: true }).finally(() => {
    initializePromise = null;
  });

  return initializePromise;
}

// 配置热更新入口：先重读配置，再刷新一个或全部服务。
export async function refreshMcpFromSettings(serverName?: string): Promise<McpManager> {
  await syncFromSettings({ reload: true, initialize: false });
  await mcpManager.refresh(serverName);
  return mcpManager;
}

// 在后台悄悄触发一次初始化，适合程序启动时预热。
export function primeMcpRuntime(): void {
  void ensureMcpInitialized();
}

// 给主提示词拼接 MCP 能力摘要。
export function getMcpPromptInstructions(): string {
  return mcpManager.buildPromptSummary();
}

export async function getDynamicMcpToolSurface(): Promise<DynamicMcpToolSurface> {
  await ensureMcpInitialized();

  const responseTools: DynamicMcpResponseTool[] = [];
  const handlers: DynamicMcpToolSurface["handlers"] = {};
  const usedNames = new Set<string>();

  for (const state of mcpManager.listServers()) {
    if (!state.enabled || state.cache.tools.length === 0) {
      continue;
    }

    for (const tool of state.cache.tools) {
      const dynamicName = ensureUniqueDynamicToolName(
        buildDynamicToolName(state.name, tool.name),
        usedNames,
        state.name,
        tool.name,
      );
      const parameters = normalizeDynamicToolSchema(tool.inputSchema);

      responseTools.push({
        type: "function",
        name: dynamicName,
        description: buildDynamicToolDescription(state.name, tool.name, tool.description),
        parameters,
      });

      handlers[dynamicName] = (args) => handleDynamicMcpToolCall(state.name, tool.name, args);
    }
  }

  const chatTools: DynamicMcpChatTool[] = responseTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

  return {
    responseTools,
    chatTools,
    handlers,
  };
}

// mcp_call 工具的统一执行入口。
// 这里负责初始化、参数校验、按 kind 分发，以及最终结果格式化。
export async function handleMcpCall(args: ToolArgs): Promise<string> {
  try {
    await ensureMcpInitialized();
    const call = validateMcpCallArgs(args);

    const result = await mcpManager.getPrompt(
      call.server,
      call.name ?? "",
      normalizePromptArguments(call.arguments),
    );
    return formatPromptResult(call.server, call.name ?? "", result);
  } catch (error) {
    return formatRuntimeError(error);
  }
}

export async function handleListMcpResources(args: ToolArgs): Promise<string> {
  try {
    await ensureMcpInitialized();
    const server = args.server === undefined ? undefined : normalizeStringInput(args.server);
    if (args.server !== undefined && !server) {
      throw new McpRuntimeError("invalid_arguments", "list_mcp_resources server must be a non-empty string when provided.");
    }
    return formatResourceList(server);
  } catch (error) {
    return formatRuntimeError(error);
  }
}

export async function handleReadMcpResource(args: ToolArgs): Promise<string> {
  try {
    await ensureMcpInitialized();
    const server = normalizeStringInput(args.server);
    const uri = normalizeStringInput(args.uri);

    if (!server) {
      throw new McpRuntimeError("invalid_arguments", "read_mcp_resource requires a non-empty server.");
    }
    if (!uri) {
      throw new McpRuntimeError("invalid_arguments", "read_mcp_resource requires a non-empty uri.");
    }

    const result = await mcpManager.readResource(server, uri);
    return formatReadResourceResult(server, uri, result);
  } catch (error) {
    return formatRuntimeError(error);
  }
}
