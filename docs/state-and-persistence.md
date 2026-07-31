# Agent 状态与持久化设计

本文基于同级目录中的 Codex 和 Claude Code 实现，分析 Agent 的运行状态、会话持久化和恢复机制，并给出一套可复用的通用设计。

本文只讨论会话状态，不讨论用户配置、认证凭据和长期记忆。

## 1. 核心结论

Codex 和 Claude Code 都没有把整个进程内存对象直接序列化到磁盘。两者都采用以下分层：

1. 内存保存当前运行状态，用于高频读写。
2. JSONL 保存已经发生的会话事实，用于恢复和审计。
3. 恢复时读取 JSONL，重建模型上下文和需要跨进程保留的业务状态。
4. 临时界面状态、网络连接、取消控制器和客户端实例不会持久化。

两者的主要区别是：

1. Codex 使用强类型事件流作为会话事实源。
2. Claude Code 使用带父节点引用的消息图，加上多种状态快照记录。
3. Codex 使用 SQLite 保存线程索引和元数据，完整历史仍然保存在 JSONL。
4. Claude Code 主要按项目目录扫描 JSONL，并通过消息父链恢复选中的分支。

## 2. Codex 的状态设计

### 2.1 运行时状态

Codex 的会话状态定义在：

```text
../codex/codex-rs/core/src/state/session.rs
```

`SessionState` 主要保存：

1. `session_configuration`，当前会话配置。
2. `history`，模型可见的上下文历史。
3. `latest_rate_limits`，最近一次限流状态。
4. `previous_turn_settings`，上一轮使用的模型和实时会话设置。
5. `auto_compact_window`，自动压缩窗口状态。
6. `additional_context`，额外上下文。
7. 权限、连接器和启动来源等运行状态。

这些字段并不会全部原样写入磁盘。真正需要恢复的部分通过事件持久化，然后在恢复阶段重新计算。

### 2.2 持久化格式

Codex 会话保存在：

```text
~/.codex/sessions/YYYY/MM/DD/rollout-时间-线程ID.jsonl
```

路径生成和写入逻辑位于：

```text
../codex/codex-rs/rollout/src/recorder.rs
```

每一行都是带时间戳的 `RolloutItem`。类型定义位于：

```text
../codex/codex-rs/protocol/src/protocol.rs
```

主要事件包括：

1. `SessionMeta`，会话 ID、工作目录、来源、版本和基础指令。
2. `ResponseItem`，用户消息、助手消息、工具调用和工具结果。
3. `TurnContext`，每一轮使用的模型、指令和上下文设置。
4. `EventMsg`，轮次开始、完成、中止、回滚等生命周期事件。
5. `Compacted`，压缩摘要、替换历史和压缩窗口编号。
6. `InterAgentCommunication`，Agent 之间需要恢复的通信记录。

### 2.3 写入模型

`RolloutRecorder` 使用单独的后台任务串行写入 JSONL：

1. 业务线程把事件发送到容量为 256 的有界通道。
2. 写入任务独占文件句柄，保证事件顺序。
3. 新会话延迟创建文件，只有出现需要持久化的内容时才创建。
4. 事件先进入 `pending_items`。
5. 写成功后才从待写队列删除。
6. 写失败时关闭文件句柄并保留未写事件。
7. 下一次 `persist` 或 `flush` 会重新打开文件并重试。

这种设计解决了并发追加、短暂文件系统错误和空会话文件问题。

### 2.4 SQLite 的职责

Codex 使用 `state_5.sqlite` 保存线程元数据，相关实现位于：

```text
../codex/codex-rs/state
../codex/codex-rs/rollout/src/state_db.rs
```

SQLite 保存的内容包括：

1. 线程 ID 和 rollout 路径。
2. 创建时间和最近更新时间。
3. 标题和预览文本。
4. 模型、推理强度和 Token 使用量。
5. 工作目录和 Git 信息。
6. 归档状态、权限模式和审批模式。

SQLite 是查询索引，不是完整会话历史的唯一事实源。数据库缺少记录时，可以从 rollout 回填。

### 2.5 恢复流程

恢复入口位于：

```text
../codex/codex-rs/core/src/thread_manager.rs
../codex/codex-rs/core/src/session/rollout_reconstruction.rs
../codex/codex-rs/core/src/session/mod.rs
```

恢复过程如下：

1. 根据线程 ID 或 rollout 路径读取持久化事件。
2. 构造 `InitialHistory::Resumed`。
3. 从较新的事件向前寻找最近的有效压缩检查点。
4. 应用 `replacement_history` 作为恢复基线。
5. 重放基线之后的消息、上下文和 Agent 通信事件。
6. 应用线程回滚事件，丢弃已经回滚的用户轮次。
7. 恢复上一轮模型设置、上下文基线和压缩窗口编号。
8. 将重建结果写入新的 `SessionState`。
9. 后续事件继续追加到原 rollout 文件。

## 3. Claude Code 的状态设计

### 3.1 运行时状态

Claude Code 将状态分散在两个主要层次。

第一层是 `QueryEngine`：

```text
../claude-code/QueryEngine.ts
```

它保存模型调用直接需要的状态：

1. `mutableMessages`，当前会话消息。
2. `totalUsage`，累计用量。
3. `readFileState`，文件读取缓存。
4. `permissionDenials`，权限拒绝记录。
5. 当前轮次加载过的技能和记忆路径。

第二层是界面和业务状态：

```text
../claude-code/state/AppStateStore.ts
```

它保存任务、MCP、通知、Todo、权限请求、团队状态和界面选择等内容。

`AppState` 不会整体落盘。只有恢复后仍然有业务意义的字段才会写入会话文件。

### 3.2 持久化路径

会话路径由以下代码生成：

```text
../claude-code/utils/sessionStorage.ts
```

实际结构为：

```text
Claude配置目录/projects/规范化项目路径/会话ID.jsonl
```

不同项目的会话天然隔离。跨项目恢复时，需要显式使用原始 JSONL 路径。

### 3.3 消息父链

Claude Code 的消息不是简单顺序数组。持久化后的 `TranscriptMessage` 包含：

1. `uuid`，消息唯一标识。
2. `parentUuid`，当前消息的父消息。
3. `logicalParentUuid`，压缩或切换会话时保留的逻辑父节点。
4. `sessionId`，所属会话。
5. `isSidechain`，是否属于 Agent 支线。
6. `agentId`、`teamName` 和 `agentName` 等 Agent 元数据。

类型定义位于：

```text
../claude-code/types/logs.ts
```

父链使一个 JSONL 文件可以同时保存回退前后的分支。恢复时选择一个叶子节点，沿 `parentUuid` 回溯到根节点，再反转为模型消息数组。

### 3.4 选择性状态持久化

Claude Code 的 JSONL 除普通消息外，还保存：

1. 会话标题、标签和最近一次提示词。
2. Agent 名称、颜色和 Agent 设置。
3. 普通模式或协调模式。
4. Worktree 状态和 PR 信息。
5. 文件历史快照。
6. 代码贡献归属快照。
7. 内容替换记录。
8. 上下文折叠提交和最新折叠快照。

这些记录和消息共用一个追加式 JSONL 文件，但恢复时会被解析到不同的状态容器中。

### 3.5 写入模型

`sessionStorage.ts` 中的 `Project` 对象负责本地写入：

1. 每个文件有独立写入队列。
2. 默认每 100 毫秒批量排空一次。
3. 单个批次按进入队列的顺序序列化。
4. 文件和目录使用受限权限创建。
5. 第一条真实消息出现前，元数据只保存在内存中，避免产生只有元数据的空会话。
6. 退出前等待写入完成，并把常用元数据重新追加到文件尾部。
7. 远程模式可以把同一类 transcript 事件同时写入远端事件服务。

### 3.6 恢复流程

恢复入口位于：

```text
../claude-code/utils/conversationRecovery.ts
../claude-code/utils/sessionStorage.ts
../claude-code/utils/sessionRestore.ts
```

恢复过程如下：

1. 选择指定会话，或者选择最近一个非活动会话。
2. 解析 JSONL 中的消息、元数据和快照。
3. 找到候选叶子节点。
4. 沿 `parentUuid` 重建选中分支。
5. 处理旧版本 progress 消息造成的父链断点。
6. 应用压缩边界、上下文折叠和消息删除记录。
7. 检查未完成工具调用，并生成必要的中断状态。
8. 恢复文件历史、贡献归属和 Todo。
9. 恢复 Agent 设置、模式、Worktree 和会话标题。
10. 普通恢复继续使用原会话 ID，fork 模式使用新会话 ID 并复制有效历史。

## 4. code-agent 的当前实现

### 4.1 总体模型

当前项目采用的是：

```text
AgentState 内存状态
加
UiMessage 界面消息
加
完整 SessionSnapshot checkpoint
加
按 workspace 分目录的 JSONL 文件
```

它借鉴了 Claude Code 的按项目保存 JSONL 思路，但没有使用消息父链。它也保存了类似 Codex 的会话级状态，但没有把状态变化拆成可重放事件。

因此当前实现更准确的分类是：

```text
追加式完整快照存储
```

而不是：

```text
事件溯源存储
```

核心实现位于：

```text
src/types.ts
src/session-store.ts
src/index.tsx
src/agent.ts
src/compact.ts
```

### 4.2 AgentState

`AgentState` 定义在 `src/types.ts`，包含：

1. `sessionId`，本地会话 ID。
2. `previousResponseId`，Responses API 服务端上下文链指针。
3. `responseHistory`，Responses API 本地可重放历史。
4. `chatHistory`，Chat Completions 完整本地历史。
5. `pendingCompactedContext`，Responses API 切断旧链后等待注入的压缩摘要。
6. `turnCount`，用户轮次计数。
7. `roundsSinceTask`，任务进度保护计数。
8. `compactCount`，压缩次数。
9. `cumulativeUsage`，会话累计 Token 和费用。
10. `goal`，持久目标、状态、预算和使用量。

`AgentState` 同时包含模型上下文和一部分会话业务状态，是当前恢复能力的核心。

### 4.3 两种 API 模式的上下文状态

#### Responses API

Responses 模式同时维护两份上下文引用：

1. `previousResponseId` 指向服务端保存的 response 链。
2. `responseHistory` 保存本地可重放副本。

支持 `previous_response_id` 的 provider 在正常请求时只发送本轮增量，本地 `responseHistory` 主要用于 compact、resume 和上下文估算。

不支持 `previous_response_id` 的 provider 会在每次请求时重放整个 `responseHistory`。

每轮完成后，`agentLoop` 会把用户消息、助手输出、工具调用和工具结果写回 `responseHistory`。如果流在中途失败，已收到的助手文本也会进入中断历史，避免恢复后完全丢失本轮进度。

#### Chat Completions

Chat Completions 模式只依赖本地 `chatHistory`：

1. 用户消息进入 `chatHistory`。
2. 助手消息和工具调用进入 `chatHistory`。
3. 工具结果以 `role: tool` 进入 `chatHistory`。
4. 下一轮把整个历史重新发送给模型。

如果轮次被中断，代码会修复不完整的工具调用历史，避免恢复后出现只有 tool call 而没有 tool result 的非法消息序列。

### 4.4 SessionSnapshot

`SessionSnapshot` 定义在 `src/session-store.ts`：

```ts
type SessionSnapshot = {
  state: AgentState
  messages: PersistedUiMessage[]
  providerName?: string
  model?: string
  apiMode?: "responses" | "chat-completions"
  savedAt: string
}
```

一个 checkpoint 同时保存两类状态：

1. `AgentState` 用于恢复模型上下文和会话业务状态。
2. `PersistedUiMessage[]` 用于恢复终端中用户可见的历史界面。

构建快照时，`responseHistory` 和 `chatHistory` 会通过 JSON 序列化做深拷贝，避免后续内存修改影响当前快照。

UI 消息不会保存运行时 `id`，也会排除 header。恢复时按原顺序重新生成 `message-1`、`message-2` 等进程内 ID。

### 4.5 会话 ID 和目录结构

会话 ID 由时间戳和三字节随机值组成，例如：

```text
20260702153045-a1b2c3
```

默认存储根目录是：

```text
~/.xbcode/sessions
```

测试或受限环境可以通过 `XBCODE_SESSION_DIR` 覆盖。

每个 workspace 使用以下目录名：

```text
workspace目录名-SHA1绝对路径前12位
```

完整结构为：

```text
~/.xbcode/sessions/
  code-agent-工作区哈希/
    会话ID.jsonl
```

这样可以隔离不同项目，也能避免两个同名项目发生冲突。

### 4.6 JSONL 内容

每个会话文件只有两种顶层记录。

第一种是首次创建文件时写入的元数据：

```ts
type SessionMetaEntry = {
  kind: "meta"
  sessionId: string
  workspace: string
  createdAt: string
}
```

第二种是完整 checkpoint：

```ts
type SessionCheckpointEntry = {
  kind: "checkpoint"
  sessionId: string
  savedAt: string
  snapshot: SessionSnapshot
}
```

示意内容：

```json
{"kind":"meta","sessionId":"20260702153045-a1b2c3","workspace":"/workspace","createdAt":"2026-07-02T07:30:45.000Z"}
{"kind":"checkpoint","sessionId":"20260702153045-a1b2c3","savedAt":"2026-07-02T07:31:10.000Z","snapshot":{"state":{},"messages":[]}}
{"kind":"checkpoint","sessionId":"20260702153045-a1b2c3","savedAt":"2026-07-02T07:32:20.000Z","snapshot":{"state":{},"messages":[]}}
```

后面的 checkpoint 包含前面状态的完整副本，不是状态差异。

### 4.7 checkpoint 写入时机

当前代码会在以下位置保存快照：

1. 一轮 Agent 执行成功后。
2. Agent 执行外层 `finally` 中。
3. 用户主动停止或轮次发生错误后。
4. 创建、暂停、恢复、清除或调整 goal 后。
5. 自动目标续轮结束后。
6. 用户执行退出命令时。

由于成功路径和外层 `finally` 都可能调用保存，同一状态可能连续写入两个内容近似的 checkpoint。这不会影响恢复正确性，但会增加文件体积。

当前写入使用同步 `appendFileSync`：

```ts
function appendSessionCheckpoint(workspace, snapshot) {
  ensureWorkspaceDirectory()
  appendMetaIfMissing()
  appendJsonLine({ kind: "checkpoint", snapshot })
}
```

同步写的优点是退出前不需要等待异步队列。缺点是会阻塞终端主线程，而且当前没有文件锁、校验和和显式 `fsync`。

### 4.8 恢复流程

恢复有两个入口。

启动时可以执行：

```text
xbcode resume 会话ID
```

运行中可以执行：

```text
/resume
/resume 会话ID
```

恢复过程如下：

1. 根据当前 workspace 计算会话目录。
2. 读取指定会话的整个 JSONL 文件。
3. 从头解析所有行。
4. 保存最后一个 `checkpoint` 的 `snapshot`。
5. 使用快照整体替换 `agentStateRef.current`。
6. 恢复累计 Token 使用量。
7. 恢复 UI 消息并重新生成消息 ID。
8. 根据快照中的 provider 和 model 切换当前模型配置。
9. 如果恢复的 goal 仍然是 `active`，立即进入自动续轮。

简化伪代码：

```ts
function loadSession(workspace, sessionId) {
  const lines = readWholeJsonl(workspace, sessionId)
  let latest = null

  for (const line of lines) {
    const entry = JSON.parse(line)
    if (entry.kind === "checkpoint") {
      latest = entry.snapshot
    }
  }

  return latest
}

function resume(snapshot) {
  agentState = snapshot.state
  tokenUsage = snapshot.state.cumulativeUsage ?? zeroUsage()
  uiMessages = restoreMessageIds(snapshot.messages)
  switchProviderAndModel(snapshot.providerName, snapshot.model)

  if (snapshot.state.goal?.status === "active") {
    startAutomaticContinuation()
  }
}
```

当前实现不重放旧 checkpoint，也不合并差异，只使用最后一个完整快照。

### 4.9 会话列表

`listRecentSessions` 会扫描当前 workspace 目录中的所有 `.jsonl` 文件，对每个文件调用完整加载逻辑，然后提取：

1. 会话 ID。
2. 创建时间和保存时间。
3. 第一条用户 UI 消息作为标题。
4. 轮次数。
5. provider 和 model。

最后按 `savedAt` 倒序排列并返回最近十条。

当前没有 SQLite 索引，因此会话越多、单文件越大，列表操作成本越高。

### 4.10 上下文压缩和 transcript

会话 checkpoint 与压缩 transcript 是两套不同存储。

checkpoint 位于：

```text
~/.xbcode/sessions
```

压缩前完整模型历史位于当前工作目录：

```text
.transcripts/transcript_时间戳.jsonl
```

`src/compact.ts` 在压缩前把当前模型历史完整写入 transcript，然后：

1. 总结较旧前缀。
2. 保留最近两条用户消息开始的原始后缀。
3. 用摘要和最近原文替换内存历史。
4. 后续 checkpoint 保存压缩后的 `AgentState`。

Responses 模式还会清空 `previousResponseId`。如果 provider 支持服务端链路，则通过 `pendingCompactedContext` 在下一轮主动注入摘要。

当前手动 `/compact` 修改内存状态后不会立即调用 `persistCurrentSession`。如果用户压缩后直接异常退出，可能恢复到压缩前的上一个 checkpoint。下一轮完成或正常退出后才会保存压缩结果。

### 4.11 goal 的持久化

goal 直接放在 `AgentState.goal` 中，因此不需要独立存储：

```ts
type GoalState = {
  id: string
  objective: string
  status: "active" | "paused" | "blocked" | "budget_limited" | "complete"
  tokenBudget?: number
  tokensUsed: number
  timeUsedSeconds: number
  createdAt: number
  updatedAt: number
}
```

每轮结束后，`runAgentTurn` 返回本轮 Token 使用量和耗时。宿主层把它累计到 goal，然后保存 checkpoint。

恢复 active goal 后，UI 宿主循环生成隐藏续轮提示词并继续执行，直到 goal 完成、暂停、阻塞、预算耗尽或用户停止。

### 4.12 不会持久化的状态

以下状态在恢复时重新初始化：

1. `AbortController`。
2. 当前 busy 状态。
3. 流式消息 ID。
4. 工具审批弹窗和 resolver。
5. 本次会话的始终允许工具集合。
6. 用户选择题弹窗状态。
7. 待发送图片附件。
8. MCP 客户端连接。
9. teammate 的进程内运行状态。
10. Ink 组件本地状态。

这意味着 `/resume` 恢复的是模型上下文、可见消息和显式会话业务状态，不是整个进程执行现场。

### 4.13 当前实现的优点

1. 结构简单，完整快照容易理解和测试。
2. 恢复不需要复杂事件归约器。
3. 模型上下文和 UI 历史可以一起恢复。
4. 两种 API 模式共用同一个 checkpoint 格式。
5. goal 可以直接跟随会话恢复。
6. 按 workspace 隔离会话，符合 CLI 使用习惯。

### 4.14 当前实现的限制

1. 每次保存完整历史，文件体积会快速增长。
2. 保存频率和历史长度共同决定同步写阻塞时间。
3. 没有事件序号、事件 ID、校验和和 schemaVersion。
4. 没有原子快照文件，也没有显式刷盘屏障。
5. 任意一行 JSON 损坏都会让整个 `loadSessionFromFile` 返回 `null`，不能自动回退到前一个有效 checkpoint。
6. 会话列表需要完整读取每个文件。
7. 没有文件锁，多进程同时恢复并写入同一会话时可能交叉追加。
8. 没有工具副作用台账，无法判断崩溃前工具是否已经执行成功。
9. 没有真正的 fork 元数据和父会话关系。
10. checkpoint 是完整快照，历史记录虽然保留，但不能表达精细的状态变化语义。
11. 手动 compact 不会立即保存。
12. 当前恢复依赖本地 `responseHistory`，服务端 `previousResponseId` 是否仍然有效取决于 provider 的保留策略。

### 4.15 与通用设计的对应关系

```text
通用 RuntimeState        对应 AgentState
通用 UI Projection       对应 PersistedUiMessage
通用 Snapshot            对应 SessionSnapshot
通用 Event Log           当前没有
通用 Metadata Index      当前没有
通用 Tool Ledger         当前没有
通用 Compaction Event    当前只有内存替换和独立 transcript
```

如果下一步要增强可靠性，最优先的改动不是引入 SQLite，而是：

1. 加载时跳过损坏尾行并回退到最后一个有效 checkpoint。
2. 给 checkpoint 增加 schemaVersion、sequence 和 checksum。
3. 去掉同一轮结束时的重复 checkpoint。
4. 手动 compact 后立即保存。
5. 当文件明显增大后，再改成事件日志加周期快照。

## 5. 三种实现的对比

### 5.1 共同点

1. 内存状态负责运行效率，磁盘日志负责恢复。
2. 会话文件采用追加写，避免频繁重写大文件。
3. 恢复只覆盖有持久化语义的状态，不恢复网络连接、文件句柄和界面临时控制器。
4. 都需要同时处理模型上下文和用户可识别的会话身份。
5. 都把上下文压缩作为跨轮次继续工作的组成部分。

### 5.2 差异

1. Codex 的恢复语义由强类型事件决定，整体更接近事件溯源。
2. Claude Code 的分支语义由消息父链决定，回退和 fork 更自然。
3. code-agent 每次追加完整 checkpoint，恢复逻辑最简单，但空间放大最明显。
4. Codex 将线程检索交给 SQLite，JSONL 主要负责完整历史。
5. Claude Code 将多种状态记录混合写入一个 JSONL，通过记录类型区分。
6. code-agent 没有独立索引，列出会话时需要完整读取所有候选文件。
7. Codex 的压缩事件可以直接携带替换历史。
8. Claude Code 需要在加载时修复父链，并处理压缩边界前后的消息裁剪。
9. code-agent 的压缩先修改内存历史，之后由完整 checkpoint 保存结果。
10. Codex 和 Claude Code 可以从细粒度记录重建状态，code-agent 只能选择最后一个完整有效快照。

## 6. 通用设计目标

一套通用的 Agent 状态系统应满足：

1. 进程崩溃后可以恢复到最后一个完整语义边界。
2. 不要求序列化网络连接、文件句柄和取消控制器。
3. 用户消息、模型结果、工具调用和工具结果顺序确定。
4. 重复写入或重复恢复不会重复执行有副作用的工具。
5. 上下文压缩后仍然可以恢复模型需要的上下文。
6. 支持回滚、fork 和子 Agent 会话。
7. 会话列表查询不需要扫描全部大文件。
8. 单个损坏事件不会导致整个会话完全不可恢复。

## 7. 通用分层

推荐分为五层。

### 6.1 运行时状态

保存当前进程高频使用的数据：

```text
RuntimeState
  sessionId
  version
  phase
  history
  currentTurn
  usage
  compactWindow
  durableBusinessState
  ephemeralState
```

其中 `ephemeralState` 包含 AbortController、客户端实例、文件句柄、锁和界面临时状态。它不会进入持久化模型。

### 6.2 事件日志

保存已经发生的事实：

```text
SessionCreated
TurnStarted
UserMessageAdded
AssistantMessageAdded
ToolCallRequested
ToolCallCompleted
TurnCompleted
TurnAborted
ContextCompacted
StatePatched
SessionForked
```

### 6.3 快照

快照保存某个事件序号对应的可恢复状态，用于减少重放成本。快照不是唯一事实源，删除快照后仍然可以从事件日志恢复。

### 6.4 元数据索引

使用 SQLite 或其他轻量数据库保存：

1. 会话 ID。
2. 日志路径。
3. 标题和预览。
4. 创建时间和更新时间。
5. 工作目录和模型。
6. 当前状态和 Token 用量。

索引必须可以从事件日志重新生成。

### 6.5 大对象存储

图片、超大工具输出和二进制内容不应直接写入主 JSONL。主日志只保存内容哈希、大小、媒体类型和对象路径。

## 8. 通用数据结构伪代码

```ts
type SessionId = string
type EventId = string
type TurnId = string
type Sequence = number

type RuntimeState = {
  sessionId: SessionId
  version: Sequence
  phase: "idle" | "running" | "waiting_tool" | "stopped"
  history: ModelItem[]
  currentTurn?: {
    turnId: TurnId
    userMessageId: string
    pendingToolCalls: Map<string, ToolCall>
  }
  usage: {
    inputTokens: number
    outputTokens: number
  }
  compactWindow: number
  business: {
    goal?: GoalState
    todos: Todo[]
    mode: string
  }
  ephemeral: {
    abortController?: AbortController
    modelClient?: ModelClient
    openFiles: FileHandle[]
  }
}

type DurableEvent = {
  eventId: EventId
  sessionId: SessionId
  sequence: Sequence
  timestamp: string
  schemaVersion: number
  expectedVersion: Sequence
  payload:
    | { type: "session_created"; cwd: string; model: string }
    | { type: "turn_started"; turnId: TurnId }
    | { type: "user_message_added"; turnId: TurnId; item: ModelItem }
    | { type: "assistant_message_added"; turnId: TurnId; item: ModelItem }
    | { type: "tool_call_requested"; turnId: TurnId; call: ToolCall }
    | { type: "tool_call_completed"; turnId: TurnId; result: ToolResult }
    | { type: "turn_completed"; turnId: TurnId; usage: Usage }
    | { type: "turn_aborted"; turnId: TurnId; reason: string }
    | {
        type: "context_compacted"
        window: number
        replacementHistory: ModelItem[]
      }
    | { type: "state_patched"; patch: BusinessStatePatch }
    | {
        type: "session_forked"
        parentSessionId: SessionId
        parentSequence: Sequence
      }
}

type Snapshot = {
  sessionId: SessionId
  throughSequence: Sequence
  schemaVersion: number
  state: Omit<RuntimeState, "ephemeral">
  checksum: string
}
```

## 9. 状态归约器伪代码

所有持久化事件通过同一个纯函数更新状态。恢复和在线运行必须复用相同的归约器，避免两套语义漂移。

```ts
function reduce(state: RuntimeState, event: DurableEvent): RuntimeState {
  assert(event.sessionId === state.sessionId)
  assert(event.expectedVersion === state.version)
  assert(event.sequence === state.version + 1)

  const next = cloneWithoutEphemeralMutation(state)

  switch (event.payload.type) {
    case "turn_started":
      assert(next.phase === "idle")
      next.phase = "running"
      next.currentTurn = {
        turnId: event.payload.turnId,
        userMessageId: "",
        pendingToolCalls: new Map(),
      }
      break

    case "user_message_added":
      assert(next.currentTurn?.turnId === event.payload.turnId)
      next.history.push(event.payload.item)
      next.currentTurn.userMessageId = event.payload.item.id
      break

    case "assistant_message_added":
      assert(next.currentTurn?.turnId === event.payload.turnId)
      next.history.push(event.payload.item)
      break

    case "tool_call_requested":
      assert(next.currentTurn?.turnId === event.payload.turnId)
      next.phase = "waiting_tool"
      next.currentTurn.pendingToolCalls.set(
        event.payload.call.callId,
        event.payload.call,
      )
      break

    case "tool_call_completed":
      assert(next.currentTurn?.turnId === event.payload.turnId)
      next.history.push(toModelToolResult(event.payload.result))
      next.currentTurn.pendingToolCalls.delete(event.payload.result.callId)
      next.phase = "running"
      break

    case "turn_completed":
      assert(next.currentTurn?.turnId === event.payload.turnId)
      assert(next.currentTurn.pendingToolCalls.size === 0)
      next.usage.inputTokens += event.payload.usage.inputTokens
      next.usage.outputTokens += event.payload.usage.outputTokens
      next.currentTurn = undefined
      next.phase = "idle"
      break

    case "turn_aborted":
      assert(next.currentTurn?.turnId === event.payload.turnId)
      next.history.push(makeInterruptedMarker(event.payload.reason))
      next.currentTurn = undefined
      next.phase = "idle"
      break

    case "context_compacted":
      assert(event.payload.window > next.compactWindow)
      next.history = event.payload.replacementHistory
      next.compactWindow = event.payload.window
      break

    case "state_patched":
      next.business = applyValidatedPatch(
        next.business,
        event.payload.patch,
      )
      break

    case "session_forked":
    case "session_created":
      break
  }

  next.version = event.sequence
  return next
}
```

## 10. 单写者持久化伪代码

一个会话只能有一个有序写入者。所有业务状态变更都通过 `emit` 提交。

```ts
class SessionWriter {
  private state: RuntimeState
  private queue = new AsyncQueue<Command>()
  private seenEventIds = new Set<EventId>()

  async emit(payload: DurableEvent["payload"]): Promise<void> {
    return this.queue.runExclusive(async () => {
      const event: DurableEvent = {
        eventId: uuid(),
        sessionId: this.state.sessionId,
        sequence: this.state.version + 1,
        expectedVersion: this.state.version,
        timestamp: nowIso(),
        schemaVersion: CURRENT_EVENT_SCHEMA,
        payload,
      }

      validateEvent(this.state, event)

      await appendJsonLine(this.logFile, {
        ...event,
        checksum: checksum(event),
      })
      await flushFile(this.logFile)

      this.state = reduce(this.state, event)
      this.seenEventIds.add(event.eventId)

      void updateDerivedIndex(this.state).catch(reportIndexError)

      if (shouldCreateSnapshot(this.state)) {
        void writeSnapshotAtomically(this.state)
      }
    })
  }
}
```

关键约束：

1. 事件先成功写入日志，再提交对应的可恢复业务状态。
2. UI 流式文本可以提前显示，但只有完整助手消息才进入持久化日志。
3. SQLite 索引更新失败不能阻止会话继续，因为索引可以重建。
4. `flushFile` 的频率可以按风险和性能需求调整，但轮次完成和工具副作用前后必须有明确屏障。

## 11. Agent 轮次伪代码

```ts
async function runTurn(input: UserInput, session: SessionWriter) {
  const turnId = uuid()

  await session.emit({ type: "turn_started", turnId })
  await session.emit({
    type: "user_message_added",
    turnId,
    item: toModelUserMessage(input),
  })

  try {
    while (true) {
      const response = await model.generate(session.modelHistory())

      if (response.message) {
        await session.emit({
          type: "assistant_message_added",
          turnId,
          item: response.message,
        })
      }

      if (response.toolCalls.length === 0) {
        await session.emit({
          type: "turn_completed",
          turnId,
          usage: response.usage,
        })
        return response.message
      }

      for (const call of response.toolCalls) {
        await session.emit({
          type: "tool_call_requested",
          turnId,
          call,
        })

        const result = await executeToolExactlyOnce(call)

        await session.emit({
          type: "tool_call_completed",
          turnId,
          result,
        })
      }
    }
  } catch (error) {
    await session.emit({
      type: "turn_aborted",
      turnId,
      reason: publicError(error),
    })
    throw error
  }
}
```

## 12. 工具幂等伪代码

持久化事件不能完全解决进程在“工具执行成功但结果尚未写入”时崩溃的问题。具有副作用的工具需要独立的幂等键和执行台账。

```ts
async function executeToolExactlyOnce(call: ToolCall): Promise<ToolResult> {
  const key = call.callId
  const existing = await toolLedger.find(key)

  if (existing?.status === "completed") {
    return existing.result
  }

  if (existing?.status === "running") {
    return await reconcileUnknownToolExecution(existing)
  }

  await toolLedger.insert({
    key,
    toolName: call.name,
    argsHash: checksum(call.args),
    status: "running",
  })

  try {
    const result = await toolRegistry.execute(call.name, call.args, {
      idempotencyKey: key,
    })

    await toolLedger.complete(key, result)
    return result
  } catch (error) {
    await toolLedger.fail(key, publicError(error))
    throw error
  }
}
```

对于不能提供幂等语义的外部工具，恢复时不能自动重试，必须标记为 `unknown` 并要求用户确认。

## 13. 快照伪代码

```ts
async function writeSnapshotAtomically(state: RuntimeState) {
  const snapshot: Snapshot = {
    sessionId: state.sessionId,
    throughSequence: state.version,
    schemaVersion: CURRENT_SNAPSHOT_SCHEMA,
    state: removeEphemeralState(state),
    checksum: "",
  }

  snapshot.checksum = checksum(snapshot.state)

  const tempPath = snapshotPath(state.sessionId) + ".tmp"
  const finalPath = snapshotPath(state.sessionId)

  await writeFile(tempPath, serialize(snapshot))
  await flushFile(tempPath)
  await atomicRename(tempPath, finalPath)
  await flushDirectory(parentDirectory(finalPath))
}
```

建议在以下条件之一满足时生成快照：

1. 累计一定数量事件。
2. JSONL 超过指定大小。
3. 完成上下文压缩。
4. 会话正常退出。

## 14. 恢复伪代码

```ts
async function restoreSession(sessionId: SessionId): Promise<RuntimeState> {
  const snapshot = await readValidSnapshot(sessionId)

  let state = snapshot
    ? hydrateEphemeralDefaults(snapshot.state)
    : createEmptyRuntimeState(sessionId)

  const startSequence = snapshot?.throughSequence ?? 0
  const reader = openJsonlReader(sessionLogPath(sessionId))

  for await (const rawLine of reader) {
    const parsed = tryParseEvent(rawLine)

    if (!parsed.ok) {
      if (reader.isLastPartialLine()) {
        await quarantinePartialTail(rawLine)
        break
      }
      await quarantineCorruptLine(rawLine)
      continue
    }

    const event = migrateEvent(parsed.event)

    if (event.sequence <= startSequence) {
      continue
    }

    if (event.sequence !== state.version + 1) {
      throw new RecoveryError("event sequence gap")
    }

    if (!verifyChecksum(event)) {
      throw new RecoveryError("event checksum mismatch")
    }

    state = reduce(state, event)
  }

  if (state.currentTurn) {
    state = await recoverInterruptedTurn(state)
  }

  await rebuildOrRepairIndex(state)
  return state
}
```

未完成轮次的恢复策略：

1. 只有用户消息，没有模型输出时，可以标记轮次中断并等待用户重新提交。
2. 模型消息已完成，没有工具调用时，可以补写轮次完成事件。
3. 工具调用已请求但没有完成记录时，先查询工具台账。
4. 工具台账显示已完成时，补写工具结果事件。
5. 工具执行状态未知时，不自动重试有副作用操作。

## 15. 上下文压缩伪代码

压缩是新的持久化事件，不是直接覆盖旧日志。

```ts
async function compactContext(session: SessionWriter) {
  const history = session.modelHistory()
  const split = chooseStableCompactionBoundary(history)

  const summary = await summarize(split.oldPrefix)
  const replacementHistory = [
    makeSummaryMessage(summary),
    ...split.recentSuffix,
  ]

  validateNoUnresolvedToolPair(replacementHistory)

  await session.emit({
    type: "context_compacted",
    window: session.compactWindow() + 1,
    replacementHistory,
  })

  await session.createSnapshot()
}
```

压缩边界必须满足：

1. 不切断工具调用和工具结果。
2. 不切断正在执行的用户轮次。
3. 保留最近若干轮原文。
4. 摘要中保存任务目标、决策、文件修改、错误和待办事项。
5. 原始日志继续保留，便于审计和重新生成摘要。

## 16. fork 伪代码

```ts
async function forkSession(
  parentSessionId: SessionId,
  parentSequence: Sequence,
): Promise<SessionId> {
  const parentState = await restoreAt(
    parentSessionId,
    parentSequence,
  )

  const childSessionId = uuid()
  const child = await createSessionWriter(childSessionId)

  await child.emit({
    type: "session_created",
    cwd: parentState.cwd,
    model: parentState.model,
  })

  await child.emit({
    type: "session_forked",
    parentSessionId,
    parentSequence,
  })

  await child.installInitialSnapshot({
    ...parentState,
    sessionId: childSessionId,
    version: child.currentVersion(),
  })

  return childSessionId
}
```

父会话日志保持不变。子会话保存父会话 ID 和分叉序号，便于追踪来源。

## 17. 版本迁移

事件和快照都需要独立版本号：

```ts
function migrateEvent(event: UnknownEvent): DurableEvent {
  let current = event

  while (current.schemaVersion < CURRENT_EVENT_SCHEMA) {
    const migrate = eventMigrations[current.schemaVersion]
    current = migrate(current)
  }

  return validateCurrentEvent(current)
}
```

迁移原则：

1. 旧日志只读，不原地批量改写。
2. 加载时把旧事件转换为当前内存结构。
3. 新写入始终使用最新版本。
4. 快照不兼容时可以丢弃，并从事件日志重新生成。

## 18. 哪些状态不应该持久化

以下状态应在恢复时重新创建：

1. AbortController 和取消信号。
2. OpenAI 或其他模型客户端实例。
3. MCP 连接和子进程句柄。
4. 文件描述符和终端句柄。
5. Promise、定时器和回调函数。
6. 当前弹窗、光标位置和加载动画。
7. 可以从日志确定性计算出的缓存。

如果某个状态无法序列化，也无法从持久化事实重新计算，就说明它缺少明确的持久化语义。

## 19. 推荐实现顺序

在现有 Agent 项目中落地时，建议按以下顺序实施：

1. 定义稳定的会话事件和纯归约器。
2. 增加单写者 JSONL 日志。
3. 将用户消息、助手消息和工具调用接入事件写入。
4. 实现只依赖 JSONL 的恢复测试。
5. 增加快照，并验证删除快照后仍可恢复。
6. 增加 SQLite 元数据索引。
7. 增加工具幂等台账。
8. 增加压缩、回滚和 fork。
9. 增加事件版本迁移和损坏日志恢复。

## 20. 最终原则

通用设计可以概括为：

```text
内存状态负责运行
事件日志负责事实
快照负责速度
索引负责查询
归约器负责一致性
幂等台账负责副作用安全
```

不要把内存对象序列化当作持久化设计。可靠的持久化需要明确回答三个问题：发生了什么，哪些状态必须恢复，以及进程在任意写入边界崩溃后应该如何继续。
