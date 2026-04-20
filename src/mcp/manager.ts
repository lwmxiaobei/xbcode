import { McpClientConnection, type McpGetPromptResult, type McpReadResourceResult, type McpToolCallResult } from "./client.js";
import { McpRuntimeError, type McpCapabilitySnapshot, type McpCallKind, type McpServerConfig, type McpServerState } from "./types.js";
import { ellipsize } from "../utils.js";

// 状态报告里把时间戳统一格式化为 ISO，便于日志和排查问题时直接比对。
function formatTimestamp(value?: number): string {
  if (!value) {
    return "never";
  }
  return new Date(value).toISOString();
}

// 报告里只展示少量名字，避免大量工具或资源把输出刷满。
function joinNames(values: string[], limit = 4): string {
  if (values.length === 0) {
    return "(none)";
  }

  const preview = values.slice(0, limit);
  const suffix = values.length > limit ? `, +${values.length - limit} more` : "";
  return `${preview.join(", ")}${suffix}`;
}

// 多服务总体状态摘要，用于 /mcp 和提示词摘要里的快速总览。
type StatusSummary = {
  configured: number;
  enabled: number;
  connected: number;
  degraded: number;
  disabled: number;
  disconnected: number;
};

// McpManager 管理“多个服务连接”的生命周期。
// 它本身不直接和 SDK 通信，而是把工作分发给每个 McpClientConnection。
export class McpManager {
  private connections = new Map<string, McpClientConnection>();
  private configWarnings: string[] = [];
  private initialized = false;
  private configSignature = "";

  // 根据最新配置增删改连接对象。
  // 如果配置签名没变，直接跳过，避免重复关闭和重建连接。
  async configure(configs: McpServerConfig[], configWarnings: string[] = []): Promise<void> {
    const signature = JSON.stringify({ configs, configWarnings });
    if (signature === this.configSignature) {
      return;
    }

    const nextConnections = new Map<string, McpClientConnection>();
    for (const config of configs) {
      const existing = this.connections.get(config.name);
      if (existing) {
        existing.updateConfig(config);
        nextConnections.set(config.name, existing);
      } else {
        nextConnections.set(config.name, new McpClientConnection(config));
      }
    }

    const removed = [...this.connections.entries()]
      .filter(([name]) => !nextConnections.has(name))
      .map(([, connection]) => connection);

    await Promise.allSettled(removed.map((connection) => connection.close()));

    const disabled = [...nextConnections.values()]
      .filter((connection) => !connection.getState().enabled);
    await Promise.allSettled(disabled.map((connection) => connection.close()));

    this.connections = nextConnections;
    this.configWarnings = [...configWarnings];
    this.configSignature = signature;
    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // 仅初始化启用的服务，并容忍个别服务初始化失败。
  async initializeAll(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const enabledConnections = [...this.connections.values()]
      .filter((connection) => connection.getState().enabled);

    await Promise.allSettled(enabledConnections.map((connection) => connection.initialize()));
    this.initialized = true;
  }

  // 刷新单个服务时做精确刷新；不传名称时刷新全部服务缓存和连接状态。
  async refresh(serverName?: string): Promise<void> {
    if (serverName) {
      const connection = this.connections.get(serverName);
      if (!connection) {
        throw new McpRuntimeError("server_not_found", `MCP server "${serverName}" is not configured.`);
      }
      await connection.refresh();
      this.initialized = true;
      return;
    }

    await Promise.allSettled([...this.connections.values()].map((connection) => connection.refresh()));
    this.initialized = true;
  }

  // 返回排序后的服务状态，保证上层展示稳定，不受 Map 插入顺序影响。
  listServers(): McpServerState[] {
    return [...this.connections.values()]
      .map((connection) => connection.getState())
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  // 把完整状态裁剪成更适合模型消费的能力摘要。
  listCapabilities(): McpCapabilitySnapshot[] {
    return this.listServers().map((state) => ({
      server: state.name,
      status: state.status,
      supportedKinds: this.getSupportedKinds(state),
      toolCount: state.cache.tools.length,
      resourceCount: state.cache.resources.length,
      promptCount: state.cache.prompts.length,
      tools: state.cache.tools.map((tool) => tool.name),
      resources: state.cache.resources.map((resource) => resource.uri),
      prompts: state.cache.prompts.map((prompt) => prompt.name),
      error: state.error,
    }));
  }

  getStatusSummary(): StatusSummary {
    return this.computeStatusSummary(this.listServers());
  }

  getConfigWarnings(): string[] {
    return [...this.configWarnings];
  }

  // 生成简短的提示词摘要，告诉模型当前有哪些 MCP 服务和能力可用。
  buildPromptSummary(): string {
    const states = this.listServers().filter((state) => state.enabled);
    if (states.length === 0) {
      return "MCP runtime: no configured servers.";
    }

    const lines: string[] = [
      "MCP runtime:",
      "- MCP tools are exposed as regular function tools. Call those tools directly.",
      "- Use `list_mcp_resources` and `read_mcp_resource` for MCP resource access.",
      "- Use `mcp_call` only for MCP prompt access.",
      "- Unsupported in this client: sampling, roots, elicitation.",
      "- Use exact cached server, resource, and prompt names. Do not guess missing names.",
    ];

    for (const state of states.slice(0, 6)) {
      const supportedKinds = this.getSupportedKinds(state);
      const capabilities = supportedKinds.join(", ") || "none";
      const resources = joinNames(state.cache.resources.map((resource) => resource.uri));
      const prompts = joinNames(state.cache.prompts.map((prompt) => prompt.name));
      const errorSuffix = state.error ? ` error=${ellipsize(state.error, 120)}` : "";
      lines.push(
        `- ${state.name} [${state.status}] capabilities=${capabilities} tools=${state.cache.tools.length} resources=${resources} prompts=${prompts}${errorSuffix}`,
      );
    }

    if (states.length > 6) {
      lines.push(`- ${states.length - 6} more MCP server(s) omitted from prompt summary.`);
    }

    if (this.configWarnings.length > 0) {
      lines.push(`- Config warnings present. Use /mcp to inspect them.`);
    }

    return lines.join("\n");
  }

  // 启动摘要聚焦“有哪些可用 server 和 tool”，方便用户一眼确认当前连接面。
  formatStartupReport(): string {
    const states = this.listServers().filter((state) => state.enabled);
    const lines: string[] = ["MCP servers on startup:"];

    if (states.length === 0) {
      lines.push("(no enabled MCP servers)");
    } else {
      for (const state of states) {
        const supportedKinds = this.getSupportedKinds(state);
        const capabilities = supportedKinds.join(", ") || "none";
        lines.push(`- ${state.name} [${state.status}] ${state.transport}`);
        lines.push(`  capabilities: ${capabilities}`);

        if (state.cache.tools.length === 0) {
          lines.push("  tools: (none discovered)");
        } else {
          lines.push(`  tools (${state.cache.tools.length}):`);
          for (const tool of state.cache.tools) {
            lines.push(`    - ${tool.name}`);
          }
        }

        if (state.error) {
          lines.push(`  error: ${ellipsize(state.error, 240)}`);
        }
      }
    }

    if (this.configWarnings.length > 0) {
      lines.push("", "warnings:");
      for (const warning of this.configWarnings) {
        lines.push(`- ${warning}`);
      }
    }

    return lines.join("\n");
  }

  // 生成人类可读的完整状态报告，主要用于命令行诊断。
  formatStatusReport(): string {
    const states = this.listServers();
    const summary = this.computeStatusSummary(states);
    const lines: string[] = [
      `MCP servers: configured ${summary.configured} | enabled ${summary.enabled} | connected ${summary.connected} | degraded ${summary.degraded} | disconnected ${summary.disconnected} | disabled ${summary.disabled}`,
    ];

    if (this.configWarnings.length > 0) {
      lines.push("");
      for (const warning of this.configWarnings) {
        lines.push(`warning: ${warning}`);
      }
    }

    if (states.length === 0) {
      lines.push("", "(no MCP servers configured)");
      return lines.join("\n");
    }

    for (const state of states) {
      const supportedKinds = this.getSupportedKinds(state);
      const capabilities = supportedKinds.join(", ") || "none";
      const cacheLine = `  cache: tools=${state.cache.tools.length} [${joinNames(state.cache.tools.map((tool) => tool.name))}] | resources=${state.cache.resources.length} [${joinNames(state.cache.resources.map((resource) => resource.uri))}] | prompts=${state.cache.prompts.length} [${joinNames(state.cache.prompts.map((prompt) => prompt.name))}]`;
      lines.push(
        "",
        `- ${state.name} [${state.status}] ${state.transport}`,
        `  location: ${state.location}`,
        `  timeout: ${state.timeoutMs}ms`,
        `  capabilities: ${capabilities}`,
        cacheLine,
        `  last connected: ${formatTimestamp(state.lastConnectedAt)}`,
        `  last refresh: ${formatTimestamp(state.lastRefreshAt)}`,
      );
      if (state.error) {
        lines.push(`  error: ${ellipsize(state.error, 320)}`);
      }
      if (state.lastStderr) {
        lines.push(`  stderr: ${ellipsize(state.lastStderr.replaceAll(/\s+/g, " ").trim(), 320)}`);
      }
    }

    return lines.join("\n");
  }

  // 以下三个方法是面向上层的统一分发入口。
  async callTool(server: string, tool: string, args?: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.getConnection(server).callTool(tool, args);
  }

  async readResource(server: string, uri: string): Promise<McpReadResourceResult> {
    return this.getConnection(server).readResource(uri);
  }

  async getPrompt(server: string, name: string, args?: Record<string, string>): Promise<McpGetPromptResult> {
    return this.getConnection(server).getPrompt(name, args);
  }

  listResourceDefinitions(server?: string): Array<{ server: string; uri: string; name: string; description?: string; mimeType?: string }> {
    if (server) {
      const state = this.getConnection(server).getState();
      return state.cache.resources.map((resource) => ({
        server: state.name,
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
    }

    return this.listServers().flatMap((state) =>
      state.cache.resources.map((resource) => ({
        server: state.name,
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    );
  }

  // 统一做服务存在性校验，避免每个调用入口重复写同样逻辑。
  private getConnection(serverName: string): McpClientConnection {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new McpRuntimeError("server_not_found", `MCP server "${serverName}" is not configured.`);
    }
    return connection;
  }

  // 聚合各服务状态，便于上层快速判断 MCP 整体健康度。
  private computeStatusSummary(states: McpServerState[]): StatusSummary {
    const summary: StatusSummary = {
      configured: 0,
      enabled: 0,
      connected: 0,
      degraded: 0,
      disabled: 0,
      disconnected: 0,
    };

    for (const state of states) {
      summary.configured += 1;
      if (!state.enabled || state.status === "disabled") {
        summary.disabled += 1;
        continue;
      }

      summary.enabled += 1;
      if (state.status === "connected") {
        summary.connected += 1;
      } else if (state.status === "degraded") {
        summary.degraded += 1;
      } else if (state.status === "disconnected") {
        summary.disconnected += 1;
      }
    }

    return summary;
  }

  // 从服务能力对象中提取当前客户端真正支持的调用种类。
  private getSupportedKinds(state: McpServerState): McpCallKind[] {
    const supported: McpCallKind[] = [];
    if (state.capabilities?.tools) {
      supported.push("tool");
    }
    if (state.capabilities?.resources) {
      supported.push("resource");
    }
    if (state.capabilities?.prompts) {
      supported.push("prompt");
    }
    return supported;
  }
}
