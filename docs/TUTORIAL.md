# 从零构建 Code Agent：与当前 `ts-openai-agent` 实现对齐的教程

> 这份教程基于当前仓库代码更新，不再引用已经删除的 demo 文件。本文统一以 `src/index.tsx`、`src/agent.ts`、`src/tools.ts`、`src/task-manager.ts`、`src/message-bus.ts`、`src/teammate-manager.ts`、`src/mcp-*.ts` 为准。

---

## 当前实现总览

| 主题 | 状态 | 核心文件 | 说明 |
|------|------|----------|------|
| s01 Agent 循环 | 已实现 | `src/agent.ts` | 同时支持 Responses API 和 Chat Completions API |
| s02 工具 | 已实现 | `src/tools.ts` | 基础工具、任务工具、技能工具、团队工具、MCP 入口 |
| s03 TodoWrite | 已演进 | `src/task-manager.ts` | 当前不是临时 todo，而是持久化任务板 |
| s04 子 Agent | 已实现 | `src/agent.ts` | `task` 工具派生一次性子代理 |
| s05 技能 | 已实现 | `src/skills.ts` | 全局技能 + 仓库本地技能 |
| s06 上下文压缩 | 已实现 | `src/compact.ts`、`src/agent.ts` | Chat 模式摘要压缩，Responses 模式重置上下文链 |
| s07 任务系统 | 已实现 | `src/task-manager.ts` | 文件持久化、依赖关系、自动解阻塞 |
| s08 后台任务 | 部分实现 | `src/teammate-manager.ts` | 目前没有通用后台作业系统，最接近的是常驻 teammate |
| s09 Agent 团队 | 已实现 | `src/message-bus.ts`、`src/teammate-manager.ts` | `lead` + 多个常驻 teammate |
| s10 团队协议 | 已实现 | `src/message-bus.ts`、`src/agent.ts` | 基于 inbox 的异步消息协议 |
| s11 自主 Agent | 部分实现 | `src/agent.ts`、`src/index.tsx` | 能自主用工具，但没有长期调度器 |
| s12 Worktree + 任务隔离 | 未实现 | - | 当前仍共享同一个工作目录 |
| s13 MCP 集成 | 已实现 | `src/config.ts`、`src/mcp/runtime.ts`、`src/mcp/manager.ts` | MCP tool 动态暴露，resource/prompt 走 `mcp_call` |

---

## 目录

### 🔵 工具与执行
- [s01 Agent 循环](#s01-agent-循环)
- [s02 工具](#s02-工具)

### 🟢 规划与协调
- [s03 TodoWrite](#s03-todowrite)
- [s04 子 Agent](#s04-子-agent)
- [s05 技能](#s05-技能)
- [s07 任务系统](#s07-任务系统)

### 🟣 内存管理
- [s06 上下文压缩](#s06-上下文压缩)

### 🟠 并发
- [s08 后台任务](#s08-后台任务)

### 🔴 协作
- [s09 Agent 团队](#s09-agent-团队)
- [s10 团队协议](#s10-团队协议)
- [s11 自主 Agent](#s11-自主-agent)
- [s12 Worktree + 任务隔离](#s12-worktree--任务隔离)

### ⚙️ 扩展
- [s13 MCP 集成](#s13-mcp-集成)

---

## s01 Agent 循环

### 核心概念

当前项目的 Agent 循环已经不是早期教程里的单文件示例，而是拆成了三层：

1. `src/index.tsx`
   负责 CLI、模型选择、命令处理、UI 渲染、`UiBridge`
2. `src/agent.ts`
   负责真正的推理循环、工具调用、上下文压缩、中断恢复
3. `src/tools.ts`
   负责工具定义和 handler 路由

主链路可以概括成：

```text
用户输入
  -> runAgentTurn()
  -> prepareToolRuntime()
  -> runTurn()
  -> Responses / Chat Completions 循环
  -> 工具调用
  -> 工具结果回填
  -> 最终回复
```

### 当前状态对象

主 agent 的运行状态定义在 `src/types.ts`：

```ts
export type AgentState = {
  previousResponseId?: string;
  chatHistory: ChatMessage[];
  turnCount: number;
  launchedAt: number;
  roundsSinceTask: number;
  compactCount: number;
};
```

这比旧教程多了两个重要字段：

- `roundsSinceTask`
  用来判断任务系统是否长时间没有更新
- `compactCount`
  用来统计上下文压缩次数

teammate 也有自己的状态对象，结构基本一致，但额外带 `name` 和 `role`。

### 两种 API 模式

`src/config.ts` 中的 `resolveApiMode()` 会在两种模式之间切换：

- `responses`
- `chat-completions`

规则是：

- 显式配置 `apiMode`
  优先采用配置值
- 如果 `baseURL` 包含 `deepseek.com`
  自动退到 `chat-completions`
- 其他情况默认 `responses`

### Agent 入口

真实入口在 `src/agent.ts`：

```ts
export async function runAgentTurn(
  config: AgentConfig,
  query: string,
  state: AgentState,
  bridge: UiBridge,
  control?: RunControl,
): Promise<void> {
  const runtime = await prepareToolRuntime(buildLeadHandlers(config, bridge), TOOLS, CHAT_TOOLS);
  await runTurn(config, query, state, bridge, runtime.handlers, runtime.responseTools, runtime.chatTools, control);
}
```

这里和旧教程最大的区别是 `prepareToolRuntime()`。

它不只返回静态工具，还会把 MCP server 暴露出来的动态 tool 面拼进去，所以每一轮真正看到的工具面是：

- 基础工具
- 任务工具
- 技能工具
- 团队工具
- 动态 MCP tool

### `runTurn()` 的分支

`runTurn()` 按 API 模式分成两条路径：

#### 1. `chat-completions`

- 清理旧 assistant 消息中的 `reasoning_content`
- 对 `chatHistory` 做 `microCompact`
- 超过阈值时触发 `autoCompact`
- 把用户消息加入 `chatHistory`
- 进入 `agentLoopWithChatCompletions()`

#### 2. `responses`

- 每 20 轮重置一次 `previousResponseId`
- 进入 `agentLoop()`
- 服务端通过 `previous_response_id` 维持上下文链

### 循环终止条件

两种模式的终止条件都一样：

- 模型不再返回 tool call
- 当前回合结束

也就是说，真正的 agent loop 不是“一问一答”，而是：

```text
用户问题 -> 模型 -> 工具 -> 模型 -> 工具 -> ... -> 最终回复
```

### 中断恢复

当前代码专门处理了 CLI 中断：

- `Esc` 会触发 `AbortController`
- `streamResponse()` / `streamChatCompletion()` 会抛出 `TurnInterruptedError`
- Chat 模式下会用 `repairInterruptedToolCallHistory()` 修复半截 tool call 历史
- Responses 模式下会尽量保住 `responseId`

这让“停止当前回合但保留会话”成为一个正式能力，而不是 UI 层强行打断。

---

## s02 工具

### 核心概念

当前仓库不是只有四个最小工具，而是把工具按权限拆成三层：

1. `BASE_TOOLS`
   所有 agent 都可见
2. `TOOLS`
   主 agent 的完整工具面
3. `TEAMMATE_TOOLS`
   teammate 可见的受限工具面

### 基础工具

`src/tools.ts` 中的 `BASE_TOOLS` 目前包含：

- `bash`
- `read_file`
- `write_file`
- `edit_file`
- `task_create`
- `task_update`
- `task_list`
- `task_get`
- `mcp_call`
- `load_skill`

这比旧教程多出三类能力：

- 持久化任务管理
- 技能系统
- MCP 资源 / prompt 访问

### 主 agent 独有工具

主 agent 额外拥有：

- `task`
  派生一次性子 Agent
- `message_send`
  给 `lead` 或 teammate 发消息
- `teammate_spawn`
- `teammate_list`
- `teammate_shutdown`
- `lead_inbox`

teammate 不允许再派生子 Agent，也不能再扩展团队，只保留：

- `BASE_TOOLS`
- `message_send`

这样做是为了避免无限递归扩张。

### 工具 handler 路由

工具分发表定义在 `BASE_TOOL_HANDLERS`：

```ts
export const BASE_TOOL_HANDLERS = {
  bash: ({ command }, control) => runBash(String(command), control?.signal),
  read_file: ({ path: filePath, limit }) => runRead(String(filePath), toOptionalNumber(limit)),
  write_file: ({ path: filePath, content }) => runWrite(String(filePath), String(content)),
  edit_file: ({ path: filePath, old_text, new_text }) => runEdit(String(filePath), String(old_text), String(new_text)),
  mcp_call: (args) => handleMcpCall(args),
  task_create: ({ subject, description }) => taskManager.create(String(subject), toOptionalString(description)),
  task_update: ({ task_id, status, blocked_by, blocks }) => taskManager.update(Number(task_id), toOptionalString(status), blocked_by as number[] | undefined, blocks as number[] | undefined),
  task_list: () => taskManager.list(),
  task_get: ({ task_id }) => taskManager.get(Number(task_id)),
  load_skill: ({ name }) => skillLoader.getContent(String(name)),
  teammate_list: () => teammateManager.formatTeamStatus(),
  lead_inbox: ({ drain }) => formatMailboxMessages(drain ? messageBus.drainInbox(LEAD_NAME) : messageBus.readInbox(LEAD_NAME)),
};
```

设计原则仍然延续了旧教程的思路：

- 工具统一返回字符串
- 错误尽量转成文本而不是抛异常
- 输出有长度上限
- 文件读写受工作区沙箱约束

### 安全边界

`bash` 和文件工具仍然保留了最基本的保护：

- `safePath()` 阻止路径逃逸
- 危险命令片段黑名单
- `timeout: 120_000`
- 输出截断到 50K 字符

### Chat 模式工具格式

Responses API 和 Chat Completions API 的 tool schema 不同，所以当前代码会把内部工具定义转换成：

- `TOOLS`
  给 Responses API
- `CHAT_TOOLS`
  给 Chat Completions API

### 动态 MCP tool

这是当前代码和旧教程最大的结构变化之一。

MCP 远端 `tool` 不再只通过一个固定入口调用，而是会在运行时动态展开成普通 function tool。当前策略是：

- MCP `tool`
  动态暴露为常规 tool
- MCP `resource` / `prompt`
  仍通过 `mcp_call` 使用

这样模型能像调用本地工具一样直接调用远端 MCP tool，同时又不会把 resource / prompt 混进同一套 schema。

### 终端 UI

教程里不能忽略 `src/index.tsx`，因为这个项目已经是一个完整 CLI，而不是无头 agent。

`UiBridge` 仍然是模型层和 UI 层之间的桥：

```ts
export type UiBridge = {
  appendAssistantDelta(delta: string): void;
  appendThinkingDelta(delta: string): void;
  finalizeStreaming(): void;
  pushAssistant(text: string): void;
  pushTool(name: string, args: ToolArgs, result: string): void;
};
```

当前 CLI 还支持这些命令：

- `/help`
- `/status`
- `/mcp`
- `/mcp refresh [name]`
- `/team`
- `/inbox`
- `/provider`
- `/model`
- `/compact`
- `/new`
- `/exit`

---

## s03 TodoWrite

### 旧概念和当前实现的差别

旧教程把 TodoWrite 讲成“临时任务清单工具”。当前仓库没有单独的 `TodoWrite` 工具，而是直接把这个能力升级成了一个持久化任务系统。

也就是说：

- 不是把 todo 只留在上下文里
- 而是把任务写入 `.tasks/`
- 由 `TaskManager` 统一管理

### 为什么这么做

临时 todo 有两个问题：

1. 会话一压缩，清单容易丢
2. 多 agent 协作时难共享

持久化任务板解决了这两个问题：

- 任务存在文件里，不依赖当前上下文窗口
- 主 agent 和 teammate 都能围绕同一组 task 协作

### 当前任务数据结构

`src/task-manager.ts` 中的任务结构是：

```ts
export interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
  blocks: number[];
}
```

这说明当前实现已经不只是 todo list，而是一个简化版 DAG。

### 任务提醒机制

`src/agent.ts` 里有一个实际运行中的提示逻辑：

- 如果任务板里还有 active task
- 且 agent 连续多轮没有更新任务状态
- 系统会插入提醒：

```text
<reminder>Update your tasks with task_list or task_update.</reminder>
```

所以当前项目已经把“计划”从 prompt 习惯推进成了工具约束。

---

## s04 子 Agent

### 当前能力

子 Agent 已经实现，对应工具名就是 `task`。

它的语义不是“开线程”，而是：

- 给一个清晰的子任务描述
- 派生一个干净上下文
- 让子 agent 独立完成
- 最终只把摘要结果返回主 agent

### 工具定义

`src/tools.ts` 中的定义：

```ts
export const TASK_TOOL = {
  type: "function",
  name: "task",
  description:
    "Dispatch a subtask to an independent sub-agent with a clean context. The sub-agent has all base tools but cannot spawn further sub-agents.",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string" },
    },
    required: ["description"],
    additionalProperties: false,
  },
} as const;
```

### 当前实现细节

`src/agent.ts` 中分别实现了：

- `subAgentLoopResponses()`
- `subAgentLoopChatCompletions()`

共同点：

- 最多跑 `MAX_SUBAGENT_ROUNDS = 30`
- 只使用 `BASE_TOOLS`
- 不允许继续 `task`
- 不允许创建 teammate
- 返回最后一次文本输出作为摘要

### 什么时候适合用

`task` 适合这些场景：

- 需要隔离上下文污染的探索任务
- 需要一次性深挖某个文件或模块
- 主 agent 想保持当前主线对话干净

不适合的场景：

- 需要持续协作
- 需要长期身份
- 需要异步收件箱

这些应该交给 Agent Teams。

---

## s05 技能

### 核心概念

技能系统已经实现，而且直接参与 system prompt 构建。

入口在 `src/skills.ts` 和 `src/index.tsx`。

### 加载顺序

技能来源有两层：

1. 全局技能目录
   `~/.claude/skills`
2. 当前仓库本地技能目录
   `./skills`

后加载的本地技能会覆盖同名全局技能。

### `SkillLoader` 的职责

`SkillLoader` 会：

- 扫描目录
- 查找每个技能目录下的 `SKILL.md`
- 解析 frontmatter
- 记录 `name`、`description`、`tags`
- 返回技能描述列表和技能正文

### 技能如何进入提示词

`src/index.tsx` 中的 `buildSystemPrompt()` 会把技能描述拼进系统提示词：

```ts
function buildSystemPrompt(): string {
  const SKILL_DESCRIPTIONS = skillLoader.getDescriptions();
  const mcpSummary = getMcpPromptInstructions();
  return `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_DESCRIPTIONS}

${mcpSummary}`;
}
```

也就是说，模型一开始只知道“有哪些技能”，真正需要时再调用 `load_skill` 读取正文。

### 为什么这样设计

这样可以减少首轮 prompt 体积：

- 描述先进入系统提示词
- 技能正文按需加载

这是一个比“把所有技能全文都塞进 prompt”更实际的做法。

---

## s07 任务系统

### 核心概念

如果说 s03 讲的是“TodoWrite 如何演化”，那 s07 讲的是当前真正落地的任务系统。

当前实现是一个文件持久化任务板：

```text
.tasks/
  task_1.json
  task_2.json
  task_3.json
```

### 关键能力

`TaskManager` 当前支持：

- `create()`
- `update()`
- `list()`
- `get()`

### 依赖关系

这个系统不是平铺的待办列表，而是支持：

- `blockedBy`
- `blocks`

当一个任务完成时，`clearDependency()` 会自动把它从其他任务的 `blockedBy` 里移除。

这意味着你已经拥有了一个最小可用的“任务依赖解除”机制。

### 输出格式

`list()` 的输出是面向模型和终端都容易消费的文本：

```text
[ ] #1: implement parser
[>] #2: add tests (blocked by: 1)
[x] #3: update docs
```

比直接返回 JSON 更适合模型在对话里快速理解任务板状态。

---

## s06 上下文压缩

### 当前实现不是单一路径

压缩逻辑已经落地，但要分 API 模式理解：

- `chat-completions`
  真的维护本地历史，也真的会摘要压缩
- `responses`
  不维护完整本地历史，所谓 compact 更接近“重开上下文链”

### 第 1 层：`microCompact()`

`src/compact.ts` 中的 `microCompact()` 会：

- 找出历史里的旧 `tool` 消息
- 永远保留最近 3 条工具输出
- 对更早且很长的 tool 输出替换成：

```text
[Previous: used <toolName>]
```

这一步不需要额外模型调用，成本很低。

### 第 2 层：`autoCompact()`

真正的摘要压缩也已经实现：

1. 先把完整历史写入 `.transcripts/`
2. 调用 `chat.completions.create()` 生成摘要
3. 用两条新消息替换旧历史

压缩后的历史只保留：

- 一条压缩摘要
- 一条 assistant 确认消息

### 阈值

当前阈值定义为：

```ts
const TOKEN_THRESHOLD = 50000;
```

估算方式是粗略的：

```ts
Math.ceil(JSON.stringify(messages).length / 4)
```

### Responses 模式的差异

Responses 模式下，当前代码每 20 轮会执行：

- `state.previousResponseId = undefined`
- `state.compactCount += 1`

它不会做本地摘要，所以更准确的说法是：

- Chat 模式做“摘要压缩”
- Responses 模式做“上下文链重置”

### 手动命令

CLI 里 `/compact` 已经接到同一套逻辑上：

- Chat 模式
  直接触发 `autoCompact()`
- Responses 模式
  直接清空 `previousResponseId`

---

## s08 后台任务

### 当前真实状态

这个主题在旧教程里是“待实现”，而当前代码属于“部分实现”。

已经有的部分：

- teammate runtime 是常驻的
- inbox 是异步的
- `lead` 可以继续接收新消息

还没有的部分：

- 一个通用后台作业执行器
- 类似 `job_start` / `job_poll` / `job_cancel` 的统一接口
- bash 命令脱离当前回合独立运行的能力

所以当前仓库还不能说“后台任务系统完整落地了”，只能说：

- 有长期运行的 teammate
- 但没有统一的后台 job 抽象

---

## s09 Agent 团队

### 当前已经实现

这部分不再是设计文档，而是实际代码。

团队系统的三个核心文件是：

- `src/message-bus.ts`
- `src/teammate-manager.ts`
- `src/team-types.ts`

### 基础结构

当前团队目录是：

```text
.team/
  config.json
  inbox/
    lead.jsonl
    alice.jsonl
    bob.jsonl
```

### `MessageBus`

`MessageBus` 负责：

- `send()`
- `readInbox()`
- `drainInbox()`
- `inboxSize()`

它采用 JSONL 收件箱，每条消息 append 一行。这样做的好处是：

- 实现简单
- 易于审计
- 适合 agent 异步通信

### `TeammateManager`

`TeammateManager` 负责：

- 成员注册
- `.team/config.json` 读写
- runtime 状态维护
- idle / wake / stop
- 团队状态展示

成员状态包括：

- `working`
- `idle`
- `stopped`
- `error`

### 当前可用团队工具

当前主 agent 可以：

- `teammate_spawn`
- `teammate_list`
- `teammate_shutdown`
- `message_send`
- `lead_inbox`

这已经够支撑一个最小可用的多 agent CLI。

---

## s10 团队协议

### 邮件格式

当前邮件类型定义在 `src/team-types.ts`：

```ts
export type MailboxMessageType =
  | "message"
  | "broadcast"
  | "shutdown_request"
  | "shutdown_response";
```

每条消息都包含：

- `id`
- `type`
- `from`
- `to`
- `content`
- `timestamp`

### 收件箱注入方式

`src/message-bus.ts` 里的 `renderInboxPrompt()` 会把收件箱消息包装成：

```xml
<inbox>
[
  {
    "from": "lead",
    "type": "message",
    "content": "...",
    "timestamp": "..."
  }
]
</inbox>
```

然后 `launchTeammateRuntime()` 会把这段 inbox prompt 当成新的用户工作指令送进 teammate。

### teammate 的系统约束

`buildTeammateSystem()` 会给 teammate 增加明确规则：

- 你是某个固定名字的 teammate
- 你不能直接和用户说话
- 你通过 `message_send` 协作
- 完成有意义的阶段后，给 `lead` 发送简洁更新

这很重要，因为团队系统能否稳定工作，不只靠工具，还靠角色边界清晰。

### 协议的本质

当前团队协议的核心不是 RPC，而是：

- 持久身份
- 异步消息
- 独立上下文
- 显式唤醒

这和一次性 `task` 子 Agent 是两套不同的协作模型。

---

## s11 自主 Agent

### 当前已经具备的自主性

当前项目已经具备“短周期自主执行”能力：

- 模型自己决定何时调用工具
- 自己决定是否创建 / 更新任务
- 自己决定是否加载技能
- 主 agent 可以自己派生子 Agent
- 主 agent 可以自己创建 teammate 并发消息

### 还没有的能力

但它还不是一个“长期自治系统”，因为缺少这些部件：

- 长期目标调度器
- 定时或事件驱动的自动唤醒
- 跨会话的高层计划恢复
- 真正的后台作业系统
- 工作目录级别的隔离执行

所以更准确的描述是：

- 这是一个会自主用工具的交互式 coding agent
- 还不是一个无人值守的长期自治 agent 平台

### 用户控制点

当前用户仍然保留强控制权：

- 信任确认提示
- 模型 / provider 切换
- `/compact`
- `/new`
- `Esc` 中断当前回合

---

## s12 Worktree + 任务隔离

### 当前状态

这部分仍然没有落地。

目前无论是：

- 主 agent
- 一次性 `task` 子 Agent
- 常驻 teammate

共享的都是同一个 `WORKDIR`。

### 现有隔离手段

虽然没有 git worktree，但当前代码已经有两层“软隔离”：

1. 上下文隔离
   `task` 子 Agent 使用独立历史
2. 角色隔离
   teammate 有独立 inbox 和独立状态

### 还缺什么

如果以后要实现真正的 worktree 隔离，至少需要补这几块：

- 每个任务一个独立目录
- teammate / sub-agent 绑定独立工作树
- 变更合并策略
- 冲突处理
- 生命周期清理

当前仓库还没有这些能力，所以文档里必须明确写成“未实现”。

---

## s13 MCP 集成

### 这是当前仓库的新增主线

旧教程没有 MCP，但当前代码已经把它接成一等公民。

相关文件：

- `src/config.ts`
- `src/mcp/types.ts`
- `src/mcp/client.ts`
- `src/mcp/manager.ts`
- `src/mcp/runtime.ts`

### 配置入口

MCP 配置现在走 `~/.codemini/settings.json`：

```json
{
  "mcp": {
    "servers": [
      {
        "name": "docs",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem"]
      }
    ]
  }
}
```

`src/config.ts` 会负责：

- 读取配置
- 归一化字段
- 过滤错误配置
- 生成 warning

### 运行时结构

MCP 调用链是：

```text
LLM / Tool call
  -> tools.ts
  -> mcp/runtime.ts
  -> mcp/manager.ts
  -> mcp/client.ts
  -> MCP server
```

### 当前支持什么

当前实现支持三种 MCP 能力：

- `tool`
- `resource`
- `prompt`

说明：

- MCP `tool`
  会被动态暴露成常规 function tool
- MCP `resource` / `prompt`
  通过 `mcp_call` 访问

### 初始化策略

MCP 不是启动时一股脑阻塞初始化，而是：

- `primeMcpRuntime()`
  启动时后台预热
- `ensureMcpInitialized()`
  首次真正调用前确保初始化
- `refreshMcpFromSettings()`
  重新读取配置并刷新 server

### CLI 支持

当前 CLI 已经提供：

- `/mcp`
  查看所有 MCP server 状态
- `/mcp refresh`
  刷新所有 server
- `/mcp refresh <name>`
  刷新单个 server

这说明 MCP 不只是库层集成，而是已经接进了真实终端工作流。

---

## 总结

1. `src/index.tsx`
   先看 CLI、系统提示词、命令处理、`UiBridge`
2. `src/agent.ts`
   再看主循环、子 Agent、teammate runtime、上下文压缩接入点
3. `src/tools.ts`
   再看工具定义、权限分层、handler 路由
4. `src/task-manager.ts`
   理解任务板
5. `src/message-bus.ts` + `src/teammate-manager.ts`
   理解 Agent Teams
6. `src/mcp/runtime.ts` + `src/mcp/manager.ts`
   理解 MCP

一句话总结当前项目：

> 这已经不是“一个带 bash 的对话 demo”，而是一个支持任务板、子 Agent、技能、上下文压缩、团队协作和 MCP 的终端 coding agent。
