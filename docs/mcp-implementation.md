# MCP 实现详解

这份文档面向项目维护者，解释 `code-agent` 当前 MCP 子系统的真实落地方式。

如果你只想快速理解整体结构，先看：

- [docs/mcp-overview.md](./mcp-overview.md)
- [docs/mcp-config.md](./mcp-config.md)

如果你准备改代码、排查连接问题、扩展新的 MCP 能力，这份文档应该作为主入口。

## 1. 设计目标

当前这套实现追求的是“在现有 agent 架构里，把 MCP 接成一等能力”，而不是完整复刻某个外部客户端。

目标分成四类：

- 连接层支持标准 MCP transport
  - `stdio`
  - `streamable-http`
- 模型可直接调用 MCP tool
  - 远端 MCP `tool` 被动态展开成普通 function tool
- 模型可访问 MCP resource / prompt
  - `resource` 通过 `list_mcp_resources` / `read_mcp_resource`
  - `prompt` 通过 `mcp_call`
- 运行时可诊断
  - 有配置告警
  - 有连接状态报告
  - 有启动摘要
  - 有手动刷新命令

## 2. 文件分层

MCP 相关代码主要分布在这几层：

- `src/config.ts`
  - 读取 `~/.codemini/settings.json`
  - 校验和归一化 `mcp.servers`
- `src/mcp/types.ts`
  - MCP 运行时的核心类型和错误类型
- `src/mcp/client.ts`
  - 单个 MCP server 的连接、能力发现、缓存、请求发送
- `src/mcp/manager.ts`
  - 多个 server 的配置同步、生命周期管理、状态汇总
- `src/mcp/runtime.ts`
  - MCP 到 agent 工具系统的适配层
- `src/tools.ts`
  - 本地工具注册和 handler 路由
- `src/agent.ts`
  - 每轮运行前把动态 MCP tools 拼到真实 tool surface
- `src/index.tsx`
  - 启动预热、`/mcp` 和 `/mcp refresh` 命令

可以把调用链记成：

```text
LLM / agent loop
  -> tools.ts
  -> mcp/runtime.ts
  -> mcp/manager.ts
  -> mcp/client.ts
  -> MCP server
```

## 3. 配置层

### 3.1 配置来源

MCP 配置统一来自：

- `~/.codemini/settings.json`

结构位于：

```json
{
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "enabled": true,
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "cwd": "/abs/path/to/project",
        "timeoutMs": 30000
      }
    ]
  }
}
```

### 3.2 配置归一化

`src/config.ts` 里的 `normalizeMcpServer()` 做了几件事：

- 校验 `name` 非空且唯一
- 校验 `transport` 只能是：
  - `stdio`
  - `streamable-http`
- 给非法 `timeoutMs` 回退默认值 `30000`
- `stdio` 模式下校验：
  - `command` 必填
  - `cwd` 若存在必须是字符串
  - `cwd` 若不存在，会记录 warning
- `streamable-http` 模式下校验：
  - `url` 必填

注意：

- 配置有 warning 时，server 不一定会被完全跳过
- 但像 `command` 缺失这类关键字段错误，会直接导致该 server 无法配置成功

### 3.3 为什么 `cwd` 很关键

`stdio` server 的子进程是在指定 `cwd` 下启动的。

如果 `cwd` 指向旧目录或不存在：

- 配置 warning 会提示
- 启动连接会失败
- `/mcp` 会看到：
  - `capabilities: none`
  - `tools: (none discovered)`

这类问题最常见，不是“工具没有注册”，而是 server 根本没连上。

## 4. 核心类型

`src/mcp/types.ts` 定义了整个子系统共享的数据结构。

### 4.1 配置和状态

- `McpServerConfig`
  - 单个 server 的静态配置
- `McpServerState`
  - 单个 server 的运行时状态
- `McpServerCache`
  - 缓存 `tools/resources/prompts`

### 4.2 能力摘要

- `McpCapabilitySnapshot`
  - 给 prompt 和上层状态展示用的精简结构

### 4.3 调用参数

- `McpCallArgs`
  - 当前仅用于 `mcp_call`
  - 现在实际只允许 `kind: "prompt"`

### 4.4 错误模型

- `McpRuntimeError`
  - 统一对外暴露的 MCP 业务错误

当前错误码包括：

- `server_not_found`
- `server_not_connected`
- `capability_unsupported`
- `invalid_arguments`
- `request_timeout`
- `transport_error`

## 5. 单连接实现：`McpClientConnection`

`src/mcp/client.ts` 里的 `McpClientConnection` 表示“一个 MCP server 的完整连接状态机”。

### 5.1 它负责什么

- 建 transport
- 建 `Client`
- 执行连接
- 读取 server capabilities
- 拉取 tools/resources/prompts
- 发送 `callTool` / `readResource` / `getPrompt`
- 处理断连、超时和 transport 错误

### 5.2 Transport 创建

#### `stdio`

使用：

- `StdioClientTransport`

特点：

- 会把裸命令先尝试 `which` 成绝对路径
- 可传递 `args`
- 可传递合并后的 `env`
- 可设置 `cwd`
- 会监听 `stderr`

`stderr` 不会无限积累，只保留尾部一段，用于状态报告。

#### `streamable-http`

使用：

- `StreamableHTTPClientTransport`

特点：

- 直接基于 URL
- 透传配置里的 `headers`

### 5.3 连接流程

`connectAndLoad()` 是核心流程：

1. 关闭旧 client
2. 把状态切到 `connecting`
3. 新建 MCP SDK `Client`
4. 注册：
   - `onclose`
   - `onerror`
5. 创建 transport 并 `connect`
6. 读取：
   - `getServerCapabilities()`
   - `getServerVersion()`
   - `getInstructions()`
7. 调 `reloadCache()`

如果中途失败：

- 不会抛裸 SDK 错误到上层
- 会把当前状态标记成 `degraded`
- `error` 字段写入可读文本

### 5.4 能力校验

即使一个 server 已连接，也不代表三种能力都可用。

每次调用前都会先走：

- `requireCapability("tools" | "resources" | "prompts", target)`

因此：

- 没声明 `tools` 的 server，不能调 `callTool`
- 没声明 `resources` 的 server，不能读 resource
- 没声明 `prompts` 的 server，不能取 prompt

### 5.5 缓存刷新

`reloadCache()` 会按 capability 分别刷新：

- `listTools()`
- `listResources()`
- `listPrompts()`

每类都支持 MCP 分页：

- 通过 `nextCursor` 一直拉到结束

这一层只缓存模型选择和本地校验真正需要的信息：

- tool
  - `name`
  - `description`
  - `inputSchema`
  - `outputSchema`
- resource
  - `uri`
  - `name`
  - `description`
  - `mimeType`
- prompt
  - `name`
  - `description`
  - `arguments`

### 5.6 错误归一化

`handleOperationFailure()` 会把 SDK 异常统一转成 `McpRuntimeError`。

特殊处理包括：

- `ConnectionClosed`
  - 关闭当前 client
  - 把状态改成 `disconnected`
- `RequestTimeout`
  - 转成 `request_timeout`
- `StreamableHTTPError`
  - 把 HTTP 状态码补进错误消息

## 6. 多连接管理：`McpManager`

`src/mcp/manager.ts` 管理所有 server。

### 6.1 核心职责

- 根据配置创建或复用 `McpClientConnection`
- 关闭被删除或禁用的连接
- 初始化全部启用 server
- 刷新一个或全部 server
- 生成 prompt 摘要
- 生成启动报告和状态报告
- 提供上层统一调用入口

### 6.2 `configure()`

`configure(configs, warnings)` 会：

- 通过配置签名避免重复重建
- 复用同名已存在连接
- 关闭被删除的连接
- 关闭被禁用的连接
- 保存配置 warnings
- 重置 `initialized = false`

### 6.3 `initializeAll()`

只初始化启用的 server：

- 对每个连接调用 `initialize()`
- 使用 `Promise.allSettled`

这意味着：

- 一个 server 连不上，不会阻塞其它 server
- MCP 子系统可以部分可用

### 6.4 对上提供的调用面

`McpManager` 对外暴露：

- `callTool(server, tool, args)`
- `readResource(server, uri)`
- `getPrompt(server, name, args)`
- `listResourceDefinitions(server?)`

其中 `listResourceDefinitions()` 是本项目自己的适配方法，给 `list_mcp_resources` 工具使用。

### 6.5 Prompt 摘要

`buildPromptSummary()` 会生成注入系统提示词的 MCP 摘要。

现在摘要会明确告诉模型：

- MCP tool 是普通 function tool，直接调用
- resource 用：
  - `list_mcp_resources`
  - `read_mcp_resource`
- prompt 用：
  - `mcp_call`
- 当前不支持：
  - `sampling`
  - `roots`
  - `elicitation`

## 7. 运行时适配：`mcp/runtime.ts`

这一层最重要，因为它直接决定“模型看见什么工具、实际怎么执行、结果怎么格式化”。

### 7.1 初始化入口

全局单例：

- `export const mcpManager = new McpManager()`

初始化去重：

- `initializePromise`

关键入口：

- `ensureMcpInitialized()`
- `refreshMcpFromSettings(serverName?)`
- `primeMcpRuntime()`

行为如下：

- `ensureMcpInitialized()`
  - 首次调用时加载 settings、配置 manager、初始化全部 server
  - 并发场景下共用一个 promise
- `refreshMcpFromSettings()`
  - 重新读取 settings
  - 再 refresh 一个或全部 server
- `primeMcpRuntime()`
  - 启动后后台预热，不阻塞首屏

### 7.2 动态 MCP tool 暴露

`getDynamicMcpToolSurface()` 会把当前缓存里的 MCP tools 转成真实可供模型调用的 function tool。

返回三部分：

- `responseTools`
  - 给 Responses API
- `chatTools`
  - 给 Chat Completions API
- `handlers`
  - 工具名 -> 实际执行函数

### 7.3 动态命名规则

当前动态 tool 名默认形如：

```text
mcp__<server>__<tool>
```

命名过程：

1. `server` 和 `tool` 各自通过 `sanitizeDynamicToolSegment()`
2. 拼成 `mcp__server__tool`
3. 如果长度超限，裁剪到 64 字符
4. 如果多个 tool 归一化后撞名，再追加短 hash：

```text
mcp__server__tool__<hash>
```

这样做的目的：

- 尽量保持可读
- 同时避免冲突导致 handler 覆盖

### 7.4 为什么 resource 不动态展开成 tool

当前设计里：

- MCP `tool`
  - 动态暴露成普通 function tool
- MCP `resource`
  - 不动态展开
  - 统一经由：
    - `list_mcp_resources`
    - `read_mcp_resource`
- MCP `prompt`
  - 统一经由 `mcp_call`

这样做有两个考虑：

- resource 往往更像“可枚举数据源”，不是动作
- prompt 需要额外字符串参数归一化，单独走入口更稳定

## 8. 本地工具层：`tools.ts`

`src/tools.ts` 注册了 MCP 暴露给模型的本地工具。

当前有三类：

- `list_mcp_resources`
  - 列出全部或某个 server 的 cached resources
- `read_mcp_resource`
  - 读取某个资源 URI
- `mcp_call`
  - 当前只用于 MCP prompt

这里要注意一件事：

`mcp_call` 虽然底层类型里还有 `McpCallKind`，但运行时校验已经收窄，只允许：

- `kind: "prompt"`

如果模型还试图用它读 `tool` 或 `resource`，会直接收到 `invalid_arguments`。

## 9. Agent 层如何拼接真实工具面

`src/agent.ts` 每次准备运行工具时，会先调用：

- `prepareToolRuntime(baseHandlers, baseResponseTools, baseChatTools)`

它会把两部分合并：

- 基础本地工具
- 动态 MCP tools

合并结果包括：

- `handlers`
- `responseTools`
- `chatTools`

因此 MCP tools 不是启动时硬编码在 `BASE_TOOLS` 里，而是每轮准备运行时根据当前缓存动态拼出来。

这也是为什么：

- server 连接成功后，不改代码也能看到新的 MCP tools
- `/mcp refresh` 后，新的 tool surface 可以生效

## 10. 结果格式化

MCP SDK 返回的是结构化对象，不能直接塞给当前工具系统。

`src/mcp/runtime.ts` 负责把它们统一转成字符串。

### 10.1 Tool result

`formatToolResult(server, name, result)` 会输出：

- `server`
- `kind: tool`
- `tool`
- `status`
- `content`
- `structuredContent`
- `toolResult`
- `_meta`

其中：

- `structuredContent`
  - 会附带一个简化 schema 摘要
- `toolResult`
  - 也会附带 schema 摘要

这样做的目的不是严格类型校验，而是让人和模型都更容易快速理解返回结构。

### 10.2 Resource result

`formatReadResourceResult()` 会输出：

- `server`
- `kind: resource`
- `uri`
- `contents`
- `_meta`

### 10.3 Prompt result

`formatPromptResult()` 会输出：

- `server`
- `kind: prompt`
- `prompt`
- `description`
- `messages`
- `_meta`

prompt 的 `messages` 会按 `[role]` 的文本视图展开。

### 10.4 Content item 收敛

MCP content item 是联合类型，当前统一处理：

- `text`
- `image`
- `audio`
- `resource`
- `resource_link`

复杂内容最终都会退化成可读字符串。

### 10.5 截断

所有最终文本都走 `limitText()`，默认限制：

- `50_000` 字符

这不是精确 token 限制，但足够避免一次 MCP 返回把上下文直接塞爆。

## 11. Resource 工具的实现

### 11.1 `list_mcp_resources`

入口：

- `handleListMcpResources(args)`

行为：

- 若传 `server`
  - 只列该 server 的 resource cache
- 若不传
  - 聚合所有 server 的 resource cache

输出格式：

```text
kind: resource_list
scope: all
count: 3

resources:
- [filesystem] README -> file:///...
```

这一步只读缓存，不会额外向远端发 `readResource`。

### 11.2 `read_mcp_resource`

入口：

- `handleReadMcpResource(args)`

要求：

- `server` 必填
- `uri` 必填

执行：

- 调 `mcpManager.readResource(server, uri)`
- 再格式化结果

## 12. Prompt 工具的实现

### 12.1 为什么还保留 `mcp_call`

因为 prompt 的调用形式和 resource/tool 不完全一样：

- 需要 `name`
- `arguments` 需要被归一化成 `Record<string, string>`

当前 `normalizePromptArguments()` 会把所有参数转成字符串：

- 字符串保留原样
- `null` / `undefined` -> `""`
- 对象 -> JSON
- 标量 -> 字符串

### 12.2 参数校验

`validateMcpCallArgs()` 现在只接受：

- 非空 `server`
- `kind === "prompt"`
- 非空 `name`
- `arguments` 若存在必须是 object

## 13. 启动和命令行行为

`src/index.tsx` 在程序启动时会做：

- `primeMcpRuntime()`

这会尝试后台初始化 MCP。

之后：

- 启动摘要通过 `mcpManager.formatStartupReport()` 输出
- `/mcp`
  - 打印完整状态报告
- `/mcp refresh`
  - 刷新全部 server
- `/mcp refresh <name>`
  - 只刷新一个 server

## 14. 调试路径

### 14.1 看启动摘要

如果 MCP 正常，启动时应该看到：

- server 名
- 状态
- capabilities
- tools 列表

如果看到：

- `capabilities: none`
- `tools: (none discovered)`

先怀疑连接失败，而不是工具注册失败。

### 14.2 看 `/mcp`

这是最直接的诊断入口。

重点看：

- `location`
- `timeout`
- `capabilities`
- `cache`
- `error`
- `stderr`

### 14.3 常见故障顺序

建议按这个顺序排查：

1. `~/.codemini/settings.json` 是否真的是当前程序读的文件
2. `mcp.servers` 是否存在
3. `cwd` 是否存在
4. `command` 是否可执行
5. `url` / `headers` 是否正确
6. server 是否真声明了对应 capability
7. `/mcp refresh` 后缓存是否更新

### 14.4 验证是否真的调用了 MCP tool

最直接的方法是强制模型别用 bash：

```text
请不要用 bash，直接调用 filesystem 的 MCP 工具查看当前工作目录内容。
```

如果真的调用了 MCP tool，工具名会是：

- `mcp__filesystem__...`

返回结果会带：

```text
server: filesystem
kind: tool
tool: ...
```

## 15. 当前边界

当前实现刻意没有覆盖的内容：

- `sampling`
- `roots`
- `elicitation`
- 把 resource/prompt 全部动态展开成独立 function tool
- 基于 MCP annotation 的更细权限策略
  - 比如 `readOnlyHint`
  - `destructiveHint`
  - `openWorldHint`
- 更复杂的结果持久化与大结果落盘

## 16. 后续可扩展点

如果后续要继续向更完整的 MCP 客户端演进，优先级建议如下。

### 16.1 注解语义下沉

把远端 tool 的注解接到本地 tool 元信息里，例如：

- 只读
- 破坏性
- open-world

这样后续做权限、提示词排序、风险提示会更自然。

### 16.2 更强的 tool identity

当前动态 tool 名已经可读，但内部还没有单独保存“原始 server/tool 元信息对象”。

如果以后要做：

- 更强的 deny rules
- 更细的审计日志
- 更稳定的跨轮映射

可以单独引入一层 MCP tool metadata map。

### 16.3 大结果持久化

现在统一是：

- 文本化
- 截断

后续如果某些 server 返回：

- 大 JSON
- 图片
- 二进制资源

可以考虑落盘后只把摘要放进上下文。

## 17. 推荐阅读顺序

如果你第一次接手这块代码，建议按这个顺序读：

1. `src/mcp/types.ts`
2. `src/mcp/manager.ts`
3. `src/mcp/runtime.ts`
4. `src/mcp/client.ts`
5. `src/tools.ts`
6. `src/agent.ts`

原因是：

- 先建立“系统边界和对外接口”
- 再进入“单连接 transport 细节”

这样比一上来就读 `mcp/client.ts` 更容易建立整体模型。
