import type { Implementation, ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

// MCP 连接层当前支持的两种传输方式：本地子进程和可流式 HTTP。
export type McpTransportType = "stdio" | "streamable-http";

// 当前运行时对外暴露的三类调用能力。
export type McpCallKind = "tool" | "resource" | "prompt";

// 服务状态同时描述“是否可用”和“最近一次连接结果”。
export type McpServerStatus = "disabled" | "connecting" | "connected" | "degraded" | "disconnected";

// 来自配置文件的原始 MCP 服务定义。
// 这里只保存“如何连接”，不保存运行时连接结果。
export type McpServerConfig = {
  name: string;
  enabled: boolean;
  transport: McpTransportType;
  timeoutMs: number;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
};

// MCP tool 的缓存快照，主要用于提示模型和做能力校验。
export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

// MCP resource 的缓存快照。
export type McpResourceDefinition = {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
};

// MCP prompt 的单个参数定义。
export type McpPromptArgumentDefinition = {
  name: string;
  description?: string;
  required?: boolean;
};

// MCP prompt 的缓存快照。
export type McpPromptDefinition = {
  name: string;
  description?: string;
  arguments?: McpPromptArgumentDefinition[];
};

// 运行时缓存的是服务当前可见的能力清单，避免每次提示模型都远程查询。
export type McpServerCache = {
  tools: McpToolDefinition[];
  resources: McpResourceDefinition[];
  prompts: McpPromptDefinition[];
  refreshedAt?: number;
};

// 单个服务在运行时的完整状态视图。
// 这个结构同时服务于：状态展示、工具调用前校验、错误诊断。
export type McpServerState = {
  name: string;
  enabled: boolean;
  transport: McpTransportType;
  status: McpServerStatus;
  timeoutMs: number;
  location: string;
  error?: string;
  lastStderr?: string;
  lastConnectedAt?: number;
  lastRefreshAt?: number;
  serverVersion?: Implementation;
  capabilities?: ServerCapabilities;
  instructions?: string;
  cache: McpServerCache;
};

// 面向上层展示的能力摘要，比 McpServerState 更轻，适合拼到提示词里。
export type McpCapabilitySnapshot = {
  server: string;
  status: McpServerStatus;
  supportedKinds: McpCallKind[];
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tools: string[];
  resources: string[];
  prompts: string[];
  error?: string;
};

// 外部统一传给 mcp_call 工具的参数结构。
// tool / resource / prompt 共用一套入参，再按 kind 做校验和分发。
export type McpCallArgs = {
  server: string;
  kind: McpCallKind;
  name?: string;
  uri?: string;
  arguments?: Record<string, unknown>;
};

// 运行时内部统一使用的错误码，方便稳定地暴露给工具层和 UI。
export type McpErrorCode =
  | "server_not_found"
  | "server_not_connected"
  | "capability_unsupported"
  | "invalid_arguments"
  | "request_timeout"
  | "transport_error";

// MCP 子系统统一抛出的业务错误。
// 与普通 Error 区别在于会额外携带稳定错误码，便于调用方做分类处理。
export class McpRuntimeError extends Error {
  readonly code: McpErrorCode;
  override readonly cause?: unknown;

  constructor(code: McpErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "McpRuntimeError";
    this.code = code;
    this.cause = options?.cause;
  }
}
