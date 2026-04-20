import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { McpRuntimeError, type McpPromptDefinition, type McpResourceDefinition, type McpServerCache, type McpServerConfig, type McpServerState, type McpToolDefinition } from "./types.js";
import { isPlainRecord } from "../utils.js";

// 裸命令名（非路径）在 spawn 时可能因 PATH 继承问题找不到，先用 which 解析成绝对路径。
function resolveCommand(command: string): string {
  if (command.includes(path.sep)) return command;
  try {
    return execFileSync("which", [command], { encoding: "utf8" }).trim();
  } catch {
    return command;
  }
}

const CLIENT_INFO = {
  name: "claude-code-mini",
  version: "1.0.0",
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_BUFFER_LIMIT = 4_000;

// 新建连接时默认先从空缓存开始，后续成功连接后再填充真实能力列表。
function emptyCache(): McpServerCache {
  return {
    tools: [],
    resources: [],
    prompts: [],
  };
}

// 把配置转成适合展示的连接位置字符串，便于 /mcp 报告诊断。
function formatLocation(config: McpServerConfig): string {
  if (config.transport === "stdio") {
    const command = config.command?.trim() ?? "";
    const args = (config.args ?? []).join(" ").trim();
    return `${command} ${args}`.trim() || "(stdio)";
  }
  return config.url?.trim() || "(streamable-http)";
}

// 根据配置构造统一的运行时状态快照，避免不同重置路径产生不一致状态。
function createState(config: McpServerConfig, status?: McpServerState["status"]): McpServerState {
  return {
    name: config.name,
    enabled: config.enabled,
    transport: config.transport,
    status: status ?? (config.enabled ? "disconnected" : "disabled"),
    timeoutMs: config.timeoutMs,
    location: formatLocation(config),
    cache: emptyCache(),
  };
}

// 对外暴露状态时做一层深拷贝，避免调用方意外修改内部缓存数组。
function cloneState(state: McpServerState): McpServerState {
  return {
    ...state,
    cache: {
      ...state.cache,
      tools: [...state.cache.tools],
      resources: [...state.cache.resources],
      prompts: [...state.cache.prompts],
    },
  };
}

// 只截取字符串尾部，用于保存 stderr 等“越新越有诊断价值”的文本。
function trimTail(text: string, maxLength = STDERR_BUFFER_LIMIT): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(text.length - maxLength);
}

// 把 unknown 错误尽量稳定地转成可读文本，避免出现大量 [object Object]。
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return `${error}`;
  }
  if (typeof error === "symbol") {
    return error.toString();
  }
  return "Unknown error";
}

// SDK 会用统一的 McpError + ErrorCode 表示超时和连接关闭，这里单独做类型守卫。
function isTimeoutError(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.RequestTimeout;
}

// 连接关闭属于需要“丢弃当前 client 并触发后续重连”的特殊错误。
function isConnectionClosedError(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.ConnectionClosed;
}

// 安全关闭客户端时顺手清掉事件回调，避免 close 过程再次污染状态。
async function safeClose(client?: Client): Promise<void> {
  if (!client) {
    return;
  }

  try {
    client.onclose = undefined;
    client.onerror = undefined;
    await client.close();
  } catch {
    // 忽略清理阶段的异常，避免关闭流程反向影响主逻辑。
  }
}

export type McpToolCallResult = Awaited<ReturnType<Client["callTool"]>>;
export type McpReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;
export type McpGetPromptResult = Awaited<ReturnType<Client["getPrompt"]>>;

// McpClientConnection 负责“一个服务”的连接、缓存和调用。
export class McpClientConnection {
  private config: McpServerConfig;
  private client?: Client;
  private state: McpServerState;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.state = createState(config);
  }

  // 配置变化时复用已有连接对象，只更新那些和配置直接相关的状态字段。
  updateConfig(config: McpServerConfig): void {
    const previous = this.state;
    this.config = config;
    this.state = {
      ...previous,
      enabled: config.enabled,
      transport: config.transport,
      timeoutMs: config.timeoutMs,
      location: formatLocation(config),
      status: config.enabled ? previous.status : "disabled",
      ...(config.enabled ? {} : { error: undefined }),
    };
  }

  getState(): McpServerState {
    return cloneState(this.state);
  }

  // 延迟初始化，避免为未使用的服务提前建立连接。
  async initialize(): Promise<McpServerState> {
    if (!this.config.enabled) {
      return this.applyDisabled();
    }

    if (!this.client) {
      await this.connectAndLoad();
    }
    return this.getState();
  }

  // refresh 不复用旧连接，直接走完整重连和缓存重载流程。
  async refresh(): Promise<McpServerState> {
    if (!this.config.enabled) {
      return this.applyDisabled();
    }

    await this.connectAndLoad();
    return this.getState();
  }

  // close 只负责关闭当前连接，不主动改写其他运行时字段。
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await safeClose(client);
  }

  // 禁用服务时保留最近一次发现的缓存，同时释放现有连接。
  private async applyDisabled(): Promise<McpServerState> {
    await this.close();
    this.state = {
      ...createState(this.config, "disabled"),
      cache: this.state.cache,
    };
    return this.getState();
  }

  // 以下三个公共调用入口都先确保“已连接 + 有对应 capability”，再发起真实请求。
  async callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult> {
    const client = await this.ensureUsableClient();
    this.requireCapability("tools", `tool "${name}"`);

    try {
      return await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.config.timeoutMs || DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      throw await this.handleOperationFailure(error);
    }
  }

  async readResource(uri: string): Promise<McpReadResourceResult> {
    const client = await this.ensureUsableClient();
    this.requireCapability("resources", `resource "${uri}"`);

    try {
      return await client.readResource(
        { uri },
        { timeout: this.config.timeoutMs || DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      throw await this.handleOperationFailure(error);
    }
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpGetPromptResult> {
    const client = await this.ensureUsableClient();
    this.requireCapability("prompts", `prompt "${name}"`);

    try {
      return await client.getPrompt(
        { name, arguments: args },
        { timeout: this.config.timeoutMs || DEFAULT_TIMEOUT_MS },
      );
    } catch (error) {
      throw await this.handleOperationFailure(error);
    }
  }

  // 懒建立连接，并在失败后提供稳定的业务错误而不是裸 SDK 错误。
  private async ensureUsableClient(): Promise<Client> {
    if (!this.config.enabled) {
      throw new McpRuntimeError("server_not_connected", `MCP server "${this.config.name}" is disabled.`);
    }

    if (!this.client) {
      await this.connectAndLoad();
    }

    if (!this.client) {
      throw new McpRuntimeError(
        "server_not_connected",
        `MCP server "${this.config.name}" is not connected.`,
      );
    }

    return this.client;
  }

  // 即使服务已连接，也未必支持 tool/resource/prompt 三种能力，必须先校验。
  private requireCapability(capability: "tools" | "resources" | "prompts", target: string): void {
    const capabilities = this.state.capabilities;
    if (!capabilities?.[capability]) {
      throw new McpRuntimeError(
        "capability_unsupported",
        `MCP server "${this.config.name}" does not support ${target}.`,
      );
    }
  }

  // 每次从头重连，避免配置变更或旧传输层状态泄漏到新会话中。
  private async connectAndLoad(): Promise<void> {
    const previousCache = this.state.cache;
    await this.close();

    this.state = {
      ...this.state,
      ...createState(this.config, "connecting"),
      cache: previousCache,
      capabilities: undefined,
      serverVersion: undefined,
      instructions: undefined,
      error: undefined,
      lastStderr: undefined,
    };

    // strict capability 模式可以让客户端在能力声明不匹配时尽早失败。
    const client = new Client(CLIENT_INFO, {
      capabilities: {},
      enforceStrictCapabilities: true,
    });

    // 服务端主动断开时，同步更新本地连接状态。
    client.onclose = () => {
      this.client = undefined;
      if (this.config.enabled) {
        this.state = {
          ...this.state,
          status: "disconnected",
          error: this.state.error ?? "Connection closed.",
        };
      }
    };

    // 立即暴露传输层错误，同时尽量保留最后一次已知状态用于诊断。
    client.onerror = (error) => {
      this.state = {
        ...this.state,
        status: this.client ? "degraded" : "disconnected",
        error: getErrorMessage(error),
      };
    };

    try {
      // 先建立底层 transport，再把能力、版本和缓存一起写回状态。
      const transport = this.createTransport();
      await client.connect(transport, { timeout: this.config.timeoutMs || DEFAULT_TIMEOUT_MS });
      this.client = client;
      this.state = {
        ...this.state,
        status: "connected",
        capabilities: client.getServerCapabilities(),
        serverVersion: client.getServerVersion(),
        instructions: client.getInstructions(),
        lastConnectedAt: Date.now(),
        error: undefined,
      };
      await this.reloadCache();
    } catch (error) {
      await safeClose(client);
      this.client = undefined;
      this.state = {
        ...this.state,
        status: "degraded",
        error: getErrorMessage(error),
      };
    }
  }

  // 根据 transport 类型创建具体连接对象。
  // stdio 会额外监听 stderr；HTTP 透传 headers 给远端服务。
  private createTransport() {
    if (this.config.transport === "stdio") {
      const cwd = this.config.cwd?.trim();
      if (cwd) {
        if (!fs.existsSync(cwd)) {
          throw new Error(`MCP server "${this.config.name}" cwd does not exist: ${cwd}`);
        }
        if (!fs.statSync(cwd).isDirectory()) {
          throw new Error(`MCP server "${this.config.name}" cwd is not a directory: ${cwd}`);
        }
      }

      const transport = new StdioClientTransport({
        command: resolveCommand(this.config.command ?? ""),
        args: this.config.args ?? [],
        env: Object.fromEntries(
          Object.entries({ ...process.env, ...(this.config.env ?? {}) }).filter(([, v]) => v !== undefined),
        ) as Record<string, string>,
        cwd,
        stderr: "pipe",
      });

      const stderr = transport.stderr;
      if (stderr) {
        // 只保留 stderr 尾部内容，避免诊断信息无限增长占用内存。
        stderr.on("data", (chunk) => {
          const next = `${this.state.lastStderr ?? ""}${String(chunk)}`;
          this.state = {
            ...this.state,
            lastStderr: trimTail(next),
          };
        });
      }

      return transport;
    }

    return new StreamableHTTPClientTransport(new URL(this.config.url ?? ""), {
      requestInit: {
        headers: this.config.headers,
      },
    });
  }

  // 重建缓存时并不要求所有能力都成功，只要能拿到一部分就先保留下来。
  private async reloadCache(): Promise<void> {
    if (!this.client) {
      return;
    }

    const nextCache: McpServerCache = {
      tools: [],
      resources: [],
      prompts: [],
      refreshedAt: Date.now(),
    };
    const errors: string[] = [];

    // 各类 capability 独立刷新，局部失败时仍尽量保留可用元数据。
    if (this.state.capabilities?.tools) {
      try {
        nextCache.tools = await this.listTools();
      } catch (error) {
        errors.push(`tools/list failed: ${getErrorMessage(error)}`);
      }
    }

    if (this.state.capabilities?.resources) {
      try {
        nextCache.resources = await this.listResources();
      } catch (error) {
        errors.push(`resources/list failed: ${getErrorMessage(error)}`);
      }
    }

    if (this.state.capabilities?.prompts) {
      try {
        nextCache.prompts = await this.listPrompts();
      } catch (error) {
        errors.push(`prompts/list failed: ${getErrorMessage(error)}`);
      }
    }

    this.state = {
      ...this.state,
      cache: nextCache,
      lastRefreshAt: nextCache.refreshedAt,
      status: errors.length > 0 ? "degraded" : "connected",
      error: errors.length > 0 ? errors.join("\n") : undefined,
    };
  }

  // 下面三个 list* 方法负责把 SDK 返回值裁剪成更稳定、更适合缓存的结构。
  private async listTools(): Promise<McpToolDefinition[]> {
    if (!this.client) {
      return [];
    }

    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;

    // 按 MCP 分页协议持续拉取，直到收集完整工具列表。
    do {
      const page = await this.client.listTools(
        cursor ? { cursor } : undefined,
        { timeout: this.config.timeoutMs || DEFAULT_TIMEOUT_MS },
      );

      tools.push(...page.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: isPlainRecord(tool.inputSchema) ? tool.inputSchema : undefined,
        outputSchema: isPlainRecord(tool.outputSchema) ? tool.outputSchema : undefined,
      })));

      cursor = page.nextCursor;
    } while (cursor);

    return tools;
  }

  private async listResources(): Promise<McpResourceDefinition[]> {
    if (!this.client) {
      return [];
    }

    const resources: McpResourceDefinition[] = [];
    let cursor: string | undefined;

    // resource 列表同样可能分页，不能假设一次就能拿全。
    do {
      const page = await this.client.listResources(
        cursor ? { cursor } : undefined,
        { timeout: this.config.timeoutMs || DEFAULT_TIMEOUT_MS },
      );

      resources.push(...page.resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })));

      cursor = page.nextCursor;
    } while (cursor);

    return resources;
  }

  private async listPrompts(): Promise<McpPromptDefinition[]> {
    if (!this.client) {
      return [];
    }

    const prompts: McpPromptDefinition[] = [];
    let cursor: string | undefined;

    // prompt 定义里只保留名称、描述和参数信息，足够给模型选择与调用。
    do {
      const page = await this.client.listPrompts(
        cursor ? { cursor } : undefined,
        { timeout: this.config.timeoutMs || DEFAULT_TIMEOUT_MS },
      );

      prompts.push(...page.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map((arg) => ({
          name: arg.name,
          description: arg.description,
          required: arg.required,
        })),
      })));

      cursor = page.nextCursor;
    } while (cursor);

    return prompts;
  }

  // 把底层异常归一成运行时错误，并顺便修正当前连接状态。
  private async handleOperationFailure(error: unknown): Promise<McpRuntimeError> {
    const message = getErrorMessage(error);

    // 连接被硬断开后主动丢弃 client，让下一次请求走干净的重连流程。
    if (isConnectionClosedError(error)) {
      const snapshot = this.state;
      await this.close();
      this.state = {
        ...snapshot,
        status: "disconnected",
        error: message,
      };
      return new McpRuntimeError(
        "transport_error",
        `MCP server "${this.config.name}" disconnected: ${message}`,
        { cause: error },
      );
    }

    const code = isTimeoutError(error) ? "request_timeout" : "transport_error";

    // HTTP 传输层错误带状态码，补进消息里能更快区分网络故障与服务端响应异常。
    const normalizedMessage = error instanceof StreamableHTTPError
      ? `HTTP ${error.code ?? "unknown"}: ${message}`
      : message;

    this.state = {
      ...this.state,
      status: "degraded",
      error: normalizedMessage,
    };

    return new McpRuntimeError(
      code,
      `MCP request failed for server "${this.config.name}": ${normalizedMessage}`,
      { cause: error },
    );
  }
}
