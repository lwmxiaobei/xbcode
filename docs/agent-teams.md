# Agent Teams 系统设计

本文基于 `s09 Agent 团队` 的思路，结合当前仓库实现，给出一份可直接落地到 `xbcode` 的设计文档。目标不是复述课程内容，而是明确：

- 团队 agent 的核心原理是什么
- 为什么现有 `task` 子 agent 不等于团队协作
- 应该如何接入当前项目
- 实现时哪些接口、状态和边界条件需要一次性定死

当前分析基于这些现有模块：

- `src/agent.ts`
- `src/tools.ts`
- `src/task-manager.ts`
- `src/compact.ts`
- `src/index.tsx`
- `src/types.ts`

## 1. 概述

当前项目已经具备一个可用的单 agent CLI 框架：

- 主 agent 支持 `responses` 和 `chat-completions` 两种 API 模式
- 支持一次性的 `task` 子 agent
- 支持 `.tasks/` 文件持久化任务板
- 支持上下文压缩和 transcript 落盘

但它还不具备“团队运行时”。所谓团队运行时，不是简单地多调用几次 `task`，而是给系统增加一层**常驻队友**能力：

- 队友有固定身份，不是一次性调用后销毁
- 队友之间通过异步消息协作，而不是靠函数返回值传递结果
- 队友拥有独立上下文和生命周期
- 队友可以在空闲后继续被唤醒工作

因此，`task` 适合“一次性分包”，而 Agent Teams 适合“持续协作”。

## 2. 核心概念

### 2.1 领导 agent 与队友 agent

系统中有两类角色：

- `lead`：当前 CLI 里和用户直接对话的主 agent
- `teammate`：由 `lead` 创建的后台常驻队友，例如 `alice`、`bob`

`lead` 负责：

- 创建队友
- 给队友发消息
- 查看团队状态
- 汇总队友回信

`teammate` 负责：

- 接收分配任务
- 在自己的上下文里执行
- 必要时给其他队友或 `lead` 发消息
- 空闲时进入 idle，等待下一次唤醒

### 2.2 什么是团队邮箱

团队邮箱是一套基于文件的**异步消息系统**。

它不是共享聊天上下文，也不是内存队列，而是给每个角色一个独立收件箱文件：

```text
.team/
  inbox/
    lead.jsonl
    alice.jsonl
    bob.jsonl
```

每次发送消息时，系统往目标收件箱追加一行 JSON。队友下一次执行前先读取自己的邮箱，再把这些消息注入到自己的上下文中。

它解决了 3 个问题：

- 持久身份：消息发给 `alice`，而不是发给一次性匿名 sub-agent
- 异步协作：发送方不需要阻塞等待返回
- 上下文解耦：每个队友只看自己的邮件，不污染全局对话

### 2.3 为什么现有 `task` 不够

当前 `src/agent.ts` 中的 `task` 机制是一次性 sub-agent：

- 创建一个干净上下文
- 跑完一个子任务
- 返回最终摘要
- 立即结束

这套机制没有：

- 持久身份
- 独立邮箱
- idle / wake 生命周期
- 与其他 agent 的异步通信

所以 `task` 不能直接充当团队队友。它保留用于隔离的一次性子任务，而团队能力需要新增一层运行时。

## 3. 总体架构

采用单团队目录：

```text
.team/
  config.json
  inbox/
    lead.jsonl
    alice.jsonl
    bob.jsonl
```

架构上拆成 4 个部分：

- `TeammateManager`
  负责队友注册、状态持久化、唤醒、关闭
- `MessageBus`
  负责 JSONL 收件箱读写
- `TeammateRuntime`
  每个队友一个独立异步 loop，维护自己的上下文
- `Tool Scoping`
  区分 `lead` 和 `teammate` 的工具权限

### 3.1 推荐新增模块

```text
src/
  teammate-manager.ts
  message-bus.ts
  team-types.ts
```

现有模块修改点：

- `src/tools.ts`
- `src/agent.ts`
- `src/types.ts`
- `src/index.tsx`

## 4. 数据结构

### 4.1 团队配置

`.team/config.json` 建议结构如下：

```ts
interface TeamConfig {
  version: 1;
  leadName: "lead";
  members: Teammate[];
}

interface Teammate {
  name: string;
  role: string;
  status: "working" | "idle" | "stopped" | "error";
  createdAt: string;
  lastActiveAt: string;
}
```

字段含义：

- `leadName` 固定为 `lead`
- `members` 不包含 `lead`，只存后台队友
- `status` 用于 UI 展示和唤醒逻辑判断

### 4.2 邮件消息格式

邮箱消息统一使用 JSONL，每行一个对象：

```json
{
  "id": "msg_1742950000000_xxx",
  "type": "message",
  "from": "lead",
  "to": "alice",
  "content": "检查 src/tools.ts 的风险点，并把结论发给 bob",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

建议先支持这些 `type`：

- `message`
- `broadcast`
- `shutdown_request`
- `shutdown_response`

对应 TypeScript 接口：

```ts
interface MailboxMessage {
  id: string;
  type: "message" | "broadcast" | "shutdown_request" | "shutdown_response";
  from: string;
  to: string;
  content: string;
  timestamp: string;
}
```

## 5. 团队邮箱机制

### 5.1 写入规则

发送消息时：

1. 根据 `to` 找到目标邮箱文件
2. 以 append-only 方式追加一行 JSON
3. 如果目标队友当前是 `idle`，立刻通知运行时唤醒

append-only 的意义：

- 实现简单
- 不需要复杂锁结构
- 出问题时便于审计
- 和 `.tasks/` 的文件持久化思路一致

### 5.2 读取规则

读取自己的邮箱时采用 drain 模式：

1. 读取整个 `*.jsonl`
2. 解析为消息数组
3. 返回给调用方
4. 将文件清空

这样可以保证：

- 相同消息不会重复消费
- 消费语义简单明确
- 模型上下文中只看到“新消息”

### 5.3 如何注入模型上下文

队友每轮执行前先 `drainInbox(name)`。如果有消息，将其包装后注入自己的上下文：

```xml
<inbox>
[
  {
    "from": "lead",
    "content": "检查 src/tools.ts"
  },
  {
    "from": "bob",
    "content": "我已经完成初步 review"
  }
]
</inbox>
```

注入方式建议作为一条新的 `user` 消息，而不是拼到系统 prompt 里。理由：

- 保持系统 prompt 稳定
- 消息是动态输入，不是恒定规则
- 更符合“新收到一批工作邮件”的语义

### 5.4 `lead` 的邮箱

`lead` 本身不需要后台 loop，但仍然需要一个邮箱：

- 队友给 `lead` 回信时，写入 `.team/inbox/lead.jsonl`
- 每次用户提交新 prompt 前，CLI 先检查 `lead` 邮箱
- 如果有新邮件，把汇总结果显示到 UI，并可注入主 agent 上下文

同时建议增加 `/inbox` 命令，用于手动查看和清空 `lead` 邮箱。

## 6. 队友运行时

### 6.1 为什么不需要 `worker_threads`

当前项目的主要工作是：

- 调 OpenAI API
- 读写文件
- 管理消息状态

这些都是 I/O 型任务，不是 CPU 密集型计算。v1 使用同进程异步 Promise loop 就足够，不需要额外引入 `worker_threads` 或子进程复杂度。

### 6.2 推荐生命周期

每个队友的状态机：

```text
spawn -> working -> idle -> working -> ... -> shutdown
```

含义：

- `spawn`：创建队友并启动第一次任务
- `working`：正在处理邮箱或执行工具调用
- `idle`：当前没有待处理消息，等待唤醒
- `shutdown`：收到关闭请求后退出

### 6.3 运行循环

推荐逻辑如下：

```text
while not aborted:
  wait until awakened or inbox has work
  mark status = working
  drain inbox
  if inbox has messages:
    inject inbox message into context
  run model loop with teammate tools
  if no more tool calls and inbox empty:
    mark status = idle
```

关键点：

- 队友不是“只跑一轮就退出”
- 队友空闲时保留上下文和身份
- 新消息到达时可以继续在旧上下文上工作

### 6.4 与现有 `AgentState` 的关系

每个队友都需要自己的独立状态，不和主 agent 共享：

```ts
type TeammateRuntimeState = {
  name: string;
  previousResponseId?: string;
  chatHistory: ChatMessage[];
  turnCount: number;
  compactCount: number;
  roundsSinceTask: number;
  launchedAt: number;
}
```

这意味着现有 `AgentState` 可以复用结构，但要按队友实例分别维护。

### 6.5 上下文压缩

队友运行时应直接复用现有 `src/compact.ts` 逻辑：

- `microCompact()`
- `estimateTokens()`
- `autoCompact()`

这样队友长期运行也不会无限膨胀。

## 7. 工具权限设计

### 7.1 `lead` 工具

在现有 `TOOLS` 基础上新增：

| 工具 | 参数 | 说明 |
|------|------|------|
| `teammate_spawn` | `name`, `role`, `prompt` | 创建并启动一个队友 |
| `message_send` | `to`, `content`, `type?` | 给队友或 `lead` 发送消息 |
| `teammate_list` | 无 | 查看队友及状态 |
| `teammate_shutdown` | `name?` | 关闭一个或全部队友 |
| `lead_inbox` | `drain?` | 查看 `lead` 邮箱 |

### 7.2 `teammate` 工具

队友工具集建议定义为单独的 `TEAMMATE_TOOLS`：

- 保留：`bash`
- 保留：`read_file`
- 保留：`write_file`
- 保留：`edit_file`
- 保留：`task_create`
- 保留：`task_update`
- 保留：`task_list`
- 保留：`task_get`
- 新增：`message_send`

明确禁止：

- 不允许调用 `task`
- 不允许调用 `teammate_spawn`
- 不允许调用 `teammate_shutdown`

原因：

- 避免队友继续递归拉起 sub-agent
- 避免团队规模失控
- 把组织管理权保留给 `lead`

## 8. 接入当前项目的具体改动

### 8.1 `src/tools.ts`

需要做的事：

- 新增团队相关工具定义
- 新增 `TEAMMATE_TOOLS` 和 `TEAMMATE_CHAT_TOOLS`
- 新增对应 handler
- 初始化 `TeammateManager` 和 `MessageBus`

这里是整个系统的工具权限中心，也是最核心的接入点。

### 8.2 `src/agent.ts`

需要新增：

- `runTeammateLoopResponses()`
- `runTeammateLoopChatCompletions()`
- 队友专用 handler 构造函数

目标是尽量复用现有主 loop 逻辑，而不是重写一套完全不同的执行器。

### 8.3 `src/index.tsx`

需要新增：

- `/team` 命令，查看当前队友和状态
- `/inbox` 命令，查看 `lead` 邮箱
- 每次用户提交 prompt 前自动检查 `lead` 邮箱

UI 不需要很重，只要能看到：

- 谁在线
- 谁空闲
- 谁发来了消息

### 8.4 `src/types.ts`

建议新增：

- 团队状态相关类型
- 可能的 UI message kind 扩展

## 9. 推荐实现顺序

### 9.1 Phase 1：打通消息与状态

先实现：

- `.team/config.json`
- `.team/inbox/*.jsonl`
- `MessageBus`
- `TeammateManager`
- `/team`
- `/inbox`

这一阶段先确保状态持久化和消息流可用。

### 9.2 Phase 2：打通队友运行时

再实现：

- `teammate_spawn`
- 队友 loop
- `message_send`
- idle / wake

这一阶段让队友真正“活起来”。

### 9.3 Phase 3：完善体验

最后补：

- lead 自动收件箱注入
- 更好的状态展示
- 更清晰的 shutdown 行为
- transcript 或诊断日志

## 10. 验收场景

必须覆盖以下测试：

1. 创建队友后，`config.json` 正确写入，并出现对应邮箱文件
2. `teammate_spawn` 后队友能执行首个 prompt
3. `message_send` 能向空闲队友投递消息并唤醒
4. 队友能给其他队友和 `lead` 发回信
5. `lead` 能通过 `/inbox` 看到消息并完成 drain
6. 队友共享 `.tasks/`，一个创建任务，另一个能继续处理
7. 队友无法调用被禁止的管理类工具
8. `shutdown_request` 能让队友优雅退出并更新状态
9. `responses` 和 `chat-completions` 两种模式都能运行

建议的手工验收对话：

```text
Spawn alice as coder and bob as reviewer.
Ask alice to inspect src/tools.ts and send findings to bob.
Tell bob to summarize the risks to lead.
/inbox
/team
```

## 11. 默认假设与取舍

v1 明确采用以下默认取舍：

- 只支持单团队目录 `.team/`
- 不做多团队 `.teams/{team}` 结构
- 不做“进程重启后自动恢复运行中队友上下文”
- 不引入 `worker_threads`
- 不实现 s10 的审批协议
- 不实现 s11 的自主抢任务，只复用当前 `.tasks/`

这些取舍的目标是：先把最小可行的团队运行时接进当前项目，而不是一次性做成完整框架。

## 12. 与现有功能的边界

这套设计和现有能力的关系应明确如下：

- `task`：保留，用于一次性隔离子任务
- Agent Teams：新增，用于常驻队友协作
- `.tasks/`：继续复用，作为共享任务板
- `.transcripts/`：继续复用，作为长对话压缩前存档

它们不是相互替代关系，而是层次不同：

- `task` 是执行手段
- `tasks` 是工作项状态
- `team mailbox` 是 agent 之间的通信总线

## 13. 小结

把 `s09` 接入当前项目，关键不是“多加几个工具”，而是补上一层**持久身份 + 文件邮箱 + 常驻运行时**。

最重要的设计决策有 4 个：

- 使用 `.team/` 作为团队状态目录
- 用 JSONL 文件实现团队邮箱
- 用同进程异步 loop 实现常驻队友
- 把 `lead` 和 `teammate` 工具权限彻底分开

只要这 4 个决策不变，后续继续扩展到更复杂的团队协议、计划审批和自动调度，都不需要推翻整体架构。
