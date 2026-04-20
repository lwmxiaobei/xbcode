# ts-openai-agent 集成 MCP 协议方案

  ## Summary

  目标是在当前 CLI agent 上增加一套可复用的 MCP 客户端运行时，支持 stdio 和 Streamable HTTP 两类 server，
  统一通过一个 mcp_call 工具暴露给模型，同时让用户能在 CLI 中查看、刷新和诊断 MCP 连接状态。

  本方案按“协议握手完整、能力分阶段落地”设计：

  - v1 落地 tools、resources、prompts 三类能力
  - 按 MCP capability negotiation 处理 server 能力
  - 对 sampling、roots、elicitation 先明确为 unsupported，不在本次实现范围内，但预留扩展位

  ## Key Changes

  ### 1. 配置与启动期加载

  - 扩展 src/config.ts 对 ~/.codemini/settings.json 的读取，新增 mcp 配置段。
  - 建议配置结构：

  {
    "mcp": {
      "servers": [
        {
          "name": "filesystem",
          "enabled": true,
          "transport": "stdio",
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
          "env": {},
          "cwd": "/abs/path",
          "timeoutMs": 30000
        },
        {
          "name": "remote-docs",
          "enabled": true,
          "transport": "streamable-http",
          "url": "https://example.com/mcp",
          "headers": {},
          "timeoutMs": 30000
        }
      ]
    }
  }

  - agent 启动时加载全部 enabled server，完成：
      - transport 建连
      - initialize
      - capabilities 握手
      - 拉取并缓存 tools/list、resources/list、prompts/list
  - 缓存策略固定为“启动时加载 + 手动刷新”；失败的 server 不阻断整个 CLI，只标记为 degraded

  ### 2. 新增 MCP Runtime 层

  - 新增模块，建议拆为：
      - src/mcp/types.ts：MCP 配置、server 状态、缓存对象、统一错误类型
      - src/mcp/client.ts：单个 server 的连接、握手、请求发送、超时和重连
      - src/mcp/manager.ts：多 server 注册、缓存刷新、调用路由、状态汇总
  - McpManager 提供固定接口：
      - initializeAll()
      - refresh(serverName?)
      - listServers()
      - listCapabilities()
      - callTool(server, tool, args)
      - readResource(server, uri)
      - getPrompt(server, name, args)
  - 统一错误模型：
      - server 不存在
      - server 未连接
      - capability 不支持
      - schema/参数错误
      - 请求超时
      - transport 错误
  - 对远端和本地 server 一视同仁：已配置即信任，不增加交互确认

  ### 3. 在现有工具系统中暴露 MCP

  - 修改 src/tools.ts，新增唯一公开工具 mcp_call，不把每个 MCP tool 动态展开成 OpenAI function tool。
  - mcp_call 参数固定为：

  type McpCallArgs = {
    server: string;
    kind: "tool" | "resource" | "prompt";
    name?: string;
    uri?: string;
    arguments?: Record<string, unknown>;
  }

  - 语义约束：
      - kind="tool": 需要 name
      - kind="resource": 需要 uri
      - kind="prompt": 需要 name
  - 返回值统一为字符串，但内部保留结构化结果，格式化原则如下：
      - tool：优先拼接 text/content，保留关键 metadata
      - resource：返回正文摘要 + URI + mimeType/metadata
      - prompt：返回可直接注入模型的 prompt 文本和参数展开结果
  - 系统 prompt 追加一段 MCP 使用说明：
      - 先根据 server 能力决定调用类型
      - 调用前优先参考缓存中的名称和参数描述
      - 不要猜测不存在的 server/tool/resource/prompt 名称

  ### 4. CLI/UX 补齐

  - 修改 src/index.tsx，增加 MCP 相关 slash commands：
      - /mcp：列出 server 状态、支持能力、缓存概况
      - /mcp refresh：刷新全部 server
      - /mcp refresh <name>：刷新指定 server
  - /status 输出中补充 MCP 摘要：
      - 已连接 server 数
      - 异常 server 数

  ### 5. Agent 循环与上下文注入
  - 修改 src/agent.ts：
      - 在 lead 和 teammate 共享的 BASE_TOOL_HANDLERS 中挂入 mcp_call
      - 保证 sub-agent 也可调用 MCP
      - 支持的 kinds
      - 前若干个 tool/resource/prompt 名称
  - 不把完整 schema 全量塞进 prompt；详细 schema 由 mcp_call handler 在本地校验和格式化，避免 prompt 膨胀

  ## Public Interfaces / Type Changes

  - Settings 新增 mcp?: { servers: McpServerConfig[] }
  - 新增：
      - McpServerConfig
      - McpServerState
      - McpCapabilitySnapshot
      - McpCallArgs
  - BASE_TOOLS 新增 mcp_call
  - CLI 新增 /mcp、/mcp refresh、/mcp refresh <name>

  ## Test Plan

  - 配置解析：
      - 无 mcp 配置时 agent 正常启动
      - stdio/streamable-http 配置都能被正确解析
      - 非法配置能给出明确错误但不导致整个配置崩溃
  - 连接与握手：
      - 单个 server 成功初始化并缓存能力
      - 某个 server 初始化失败时，其它 server 仍可用
      - 手动刷新后缓存内容更新
  - 工具行为：
      - mcp_call(kind=tool) 能正确路由到指定 server/tool
      - mcp_call(kind=resource) 能读取并格式化 resource
      - mcp_call(kind=prompt) 能返回 prompt 内容
      - 缺少必须参数时返回稳定错误
  - 运行时健壮性：
      - 超时、断连、server 返回错误时不打断整个 turn
      - teammate / sub-agent 场景下也可调用 MCP
      - /mcp 与 /status 能反映真实连接状态
  - 回归检查：
      - 非 MCP 场景下，现有 bash/read_file/write_file/edit_file/task/teammate 行为不变
      - responses 与 chat-completions 两种 API 模式都能正常使用 mcp_call

  ## Assumptions

  - 本次“全协议能力”按当前 agent 的可落地边界定义为：完整做 capability negotiation，执行面支持 tools/
    resources/prompts；sampling/roots/elicitation 明确暂不实现。
  - 已配置 MCP server 默认可信，不增加首次确认流程。
  - 资源和 prompt 不单独暴露成 OpenAI tools，而统一从 mcp_call 进入，减少现有工具注册层改动。
  - 首期不做自动热刷新；server 能力变化通过启动期加载和手动刷新生效。