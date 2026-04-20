# MCP 总览

把这套 MCP 代码想成一个“总机 + 前台 + 值班表”的系统：

- `tools.ts` 像前台，负责把外部请求接进来
- `mcp/runtime.ts` 像总机，把请求整理后转给正确的人
- `mcp/manager.ts` 像值班主管，管理所有 MCP server 的连接状态
- `mcp/client.ts` 像某一位具体值班员，负责和单个 MCP server 真正通话
- `mcp/types.ts` 像统一表单，定义所有人都要遵守的数据结构和错误格式

如果只记一条主线，可以记成：

`模型/工具调用 -> tools.ts -> mcp/runtime.ts -> mcp/manager.ts -> mcp/client.ts -> MCP server`

如果你需要面向维护者的代码级说明，看：

- [docs/mcp-implementation.md](./mcp-implementation.md)

## 一张图看懂

```text
                +----------------------+
                |   LLM / Agent Loop   |
                +----------+-----------+
                           |
                           | mcp_call
                           v
                +----------------------+
                |      tools.ts        |
                | 工具注册 + handler 路由 |
                +----------+-----------+
                           |
                           v
                +----------------------+
                |   mcp/runtime.ts     |
                | 初始化 / 参数校验 / 分发 |
                +----------+-----------+
                           |
                           v
                +----------------------+
                |   mcp/manager.ts     |
                | 多 server 管理与汇总   |
                +----+-------------+---+
                     |             |
          server A   |             |   server B
                     v             v
           +----------------+ +----------------+
           | mcp/client.ts  | | mcp/client.ts  |
           | 单连接生命周期   | | 单连接生命周期   |
           +--------+-------+ +--------+-------+
                    |                  |
                    v                  v
           +----------------+ +----------------+
           |   MCP Server A | |   MCP Server B |
           +----------------+ +----------------+
```

## 文件职责

### `src/mcp/types.ts`

这一层只定义“数据长什么样”。

核心内容：

- `McpServerConfig`
  - 描述一个 MCP server 怎么连接
  - 支持 `stdio` 和 `streamable-http`
- `McpServerState`
  - 描述一个 server 当前运行状态
  - 包括连接状态、错误、缓存、最近刷新时间等
- `McpCallArgs`
  - 定义 `mcp_call` 工具的统一输入结构
- `McpRuntimeError`
  - 统一 MCP 子系统内部错误码和错误消息

这层的作用很像“协议契约”。后面的 runtime、manager、client 都围绕这些类型协作。

### `src/mcp/client.ts`

这一层负责“单个 server 的真实连接”。

它解决的问题包括：

- 根据配置创建 transport
  - `stdio` 用 `StdioClientTransport`
  - `streamable-http` 用 `StreamableHTTPClientTransport`
- 建立连接并握手
- 读取 server capabilities
- 拉取并缓存 tools/resources/prompts
- 在调用失败时更新连接状态
- 处理超时、断连、HTTP 错误

可以把它理解成：

- `McpManager` 管的是“有多少个 server”
- `McpClientConnection` 管的是“某一个 server 现在到底连没连上、能不能调用、出错后怎么恢复”

### `src/mcp/manager.ts`

这一层负责“多 server 管理”。

它不直接和 MCP SDK 通信，而是持有多个 `McpClientConnection` 实例。

主要职责：

- 根据配置创建、复用、删除连接对象
- 初始化全部启用的 server
- 刷新单个或全部 server
- 汇总所有 server 的状态
- 生成提示词摘要和 CLI 状态报告
- 把调用路由到指定 server

这层的价值在于把“多个 server 的协调问题”单独隔离出来，不让 `mcp/runtime.ts` 或 `tools.ts` 直接关心连接细节。

### `src/mcp/runtime.ts`

这一层负责“面向工具系统的适配”。

它做的事不是建连接，而是把工具调用变成统一的运行时流程：

1. 确保 MCP 已初始化
2. 校验 `mcp_call` 入参
3. 根据 `kind` 分发到 tool/resource/prompt
4. 把结果格式化成字符串返回给模型

这里的重点是“工具层体验一致”。

不管底层返回的是：

- tool 的 `content`
- resource 的 `contents`
- prompt 的 `messages`

最后都会被整理成一段可读文本，方便模型继续消费。

### `src/tools.ts`

这一层负责把 MCP 暴露给 agent 工具系统。

当前设计不是把每个远端 MCP tool 动态展开成一个本地 function tool，而是只暴露一个固定工具：

- `mcp_call`

这样做的好处：

- 工具注册层保持稳定
- 不会因为远端 tool 太多导致 prompt 膨胀
- 主 agent 和 teammate 都能共享同一套 MCP 入口

也就是说，模型看到的 MCP 能力入口只有一个，但它背后可以调用很多 server 上的很多能力。

## 一次调用是怎么走的

下面以调用一个 MCP tool 为例：

1. 模型决定调用 `mcp_call`
2. `tools.ts` 中的 `BASE_TOOL_HANDLERS.mcp_call` 接到请求
3. `tools.ts` 把参数原样交给 `handleMcpCall()`
4. `mcp/runtime.ts` 调用 `ensureMcpInitialized()`
5. `mcp/runtime.ts` 校验参数是否合法
6. `mcp/runtime.ts` 根据 `kind` 选择：
   - `tool` -> `mcpManager.callTool()`
   - `resource` -> `mcpManager.readResource()`
   - `prompt` -> `mcpManager.getPrompt()`
7. `mcp/manager.ts` 找到对应 server 的连接对象
8. `mcp/client.ts` 检查：
   - server 是否启用
   - 是否已连接
   - 是否支持对应 capability
9. `mcp/client.ts` 调 MCP SDK 发起真实请求
10. 请求结果回到 `mcp/runtime.ts`，再被格式化成字符串返回

## 初始化流程

初始化不是在每次程序启动时强制同步阻塞完成，而是采用“按需确保初始化”的方式。

关键入口：

- `ensureMcpInitialized()`
- `primeMcpRuntime()`
- `refreshMcpFromSettings()`

### 初始化步骤

1. 从配置系统读取 MCP server 配置
2. `mcpManager.configure(...)` 根据配置更新连接池
3. `mcpManager.initializeAll()` 初始化全部启用的 server
4. 每个 `McpClientConnection`：
   - 建立 transport
   - 执行 connect / initialize
   - 获取 capabilities
   - 拉取 tools/resources/prompts 缓存

### 为什么要缓存

缓存的价值主要有两点：

- 让模型在 prompt 中知道有哪些可用名字，减少瞎猜
- 避免每次调用前都重新枚举全部 tool/resource/prompt

当前缓存的是：

- `tools`
- `resources`
- `prompts`
- `refreshedAt`

缓存刷新策略比较保守：

- 初始化时拉一次
- 用户手动刷新时再拉一次

## 当前支持的能力

当前这套实现支持三种 MCP 能力：

- `tool`
- `resource`
- `prompt`

不在当前实现范围的内容：

- `sampling`
- `roots`
- `elicitation`

这意味着：

- 可以调用 MCP tool
- 可以读取 resource
- 可以获取 prompt
- 但不会处理更复杂的 MCP 交互能力

## 状态模型

`McpServerState.status` 目前有几种状态：

- `disabled`
  - 配置上关闭，不参与连接
- `connecting`
  - 正在建立连接
- `connected`
  - 已连接且缓存刷新成功
- `degraded`
  - 某一步失败了，但对象仍然存在，可用于诊断或后续重试
- `disconnected`
  - 当前没有可用连接

这套状态的关键点是：

- “连接失败”不等于“整个 agent 不可用”
- 某个 server 坏了，其它 server 仍然可以正常工作

## 为什么只暴露一个 `mcp_call`

这是这套设计里最重要的取舍之一。

如果把每个远端 MCP tool 都动态展开成本地 function tool，会有几个问题：

- tool 数量可能非常多
- prompt 容量会被远端 schema 撑大
- tool 集合会随 server 状态动态变化，稳定性差
- teammate / sub-agent 的工具同步也会变复杂

所以当前方案选择：

- 本地只注册一个稳定的 `mcp_call`
- 真正的动态部分放在 MCP 缓存和运行时里处理

这样模型虽然需要先选 `server + kind + name/uri`，但整个系统会更稳。

## 结果格式化策略

MCP SDK 返回的是结构化对象，但工具系统最终要返回字符串。

所以 `mcp/runtime.ts` 负责把不同返回类型整理成统一文本。

### tool

优先输出：

- `content`
- `structuredContent`
- `toolResult`
- `_meta`

### resource

优先输出：

- `contents`
- resource 的 `uri`
- `mimeType`
- `_meta`

### prompt

优先输出：

- `description`
- `messages`
- `_meta`

这层的目标不是“保留所有原始结构”，而是“给模型一个尽可能可继续推理的文本表示”。

## 常见易错点

### 1. 以为 server 连上了就一定能调用所有能力

不是。

MCP server 可能只支持：

- tools
- resources
- prompts

中的一部分。

所以 `mcp/client.ts` 里会先做 `requireCapability(...)` 校验。

### 2. 以为缓存失败就应该直接中断整个连接

当前实现不是这么做的。

`reloadCache()` 的策略是：

- 各 capability 分开刷新
- 某一项失败时只记录错误
- 能保留的缓存尽量保留

这样做更符合 CLI agent 的场景，因为我们更重视“部分可用”而不是“全有或全无”。

### 3. 以为 resource/prompt 不重要

这两个能力虽然不像 tool 那样直接“执行动作”，但对 agent 很重要：

- resource 适合读远端数据
- prompt 适合复用服务端预定义模板

如果只关注 tool，会误解这套 MCP 接入的完整用途。

### 4. 以为 `mcp_call` 的名字可以猜

当前实现明确依赖缓存名字：

- server 名要用配置里的精确值
- tool 名要用缓存里的精确值
- prompt 名要用缓存里的精确值
- resource 用精确 URI

也就是说，这套系统偏向“先看缓存，再调用”，不是“让模型随便猜”。

### 5. 以为 `stdio` 和 HTTP 的错误处理一样

也不完全一样。

- `stdio` 更关心进程 stderr 和连接关闭
- HTTP 更关心状态码和传输错误

所以 `mcp/client.ts` 会单独处理：

- `lastStderr`
- `StreamableHTTPError`
- `ConnectionClosed`

## 阅读代码的推荐顺序

如果第一次看这套代码，推荐按这个顺序读：

1. `src/mcp/types.ts`
   - 先搞清楚数据结构和错误码
2. `src/mcp/runtime.ts`
   - 理解外部调用入口长什么样
3. `src/mcp/manager.ts`
   - 理解多 server 是怎么管理的
4. `src/mcp/client.ts`
   - 最后看单个 server 的连接细节
5. `src/tools.ts`
   - 看它是怎么接到 agent 工具系统里的

这样读会比一上来就扎进 `mcp/client.ts` 更容易建立全局视角。

## 和 `docs/mcp-plan.md` 的关系

- `docs/mcp-plan.md` 更偏“设计方案 / 落地计划”
- 本文更偏“当前实现总览 / 阅读地图”

前者回答“准备怎么做”，后者回答“现在这套代码是怎么工作的”。
