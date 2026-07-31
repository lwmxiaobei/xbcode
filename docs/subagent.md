# Subagent 实现说明

## 概述

`subagent` 是主 agent 派发一次性子任务的工具。它会启动独立 OS 子进程，在干净上下文中运行子 agent，并把子 agent 的最终摘要作为工具结果返回给主 agent。

它适合大范围代码搜索、行为追踪、只读调研，以及独立的小型实现或修改任务。它不同于 teammate：subagent 没有持久身份、邮箱、idle/wake 生命周期，也不会跨任务保留上下文。

## 相关文件

| 文件 | 作用 |
|------|------|
| `src/tools.ts` | 定义 `subagent` 工具 schema，并挂到主 agent 工具列表 |
| `src/subagents.ts` | 定义可用子代理类型、系统提示词、允许工具和轮数上限 |
| `src/agent.ts` | 在主 agent 的 tool handler 中处理 `subagent` 调用 |
| `src/subagent-runner.ts` | 子进程启动、子 agent loop、JSONL 事件桥接 |
| `src/agent/tool-call.ts` | 通用工具调用执行逻辑，子 agent loop 复用这里的执行器 |
| `src/agent/streams.ts` | Responses API / Chat Completions API 的流式调用封装 |

## 工具入口

`subagent` 定义在 `src/tools.ts` 的 `TASK_TOOL` 中：

- 工具名：`subagent`
- 必填参数：`description`
- 可选参数：`subagent_type`
- 可选类型：`general-purpose`、`explore`

`TOOLS` 包含 `TASK_TOOL`，所以主 agent 可以调用它。`TEAMMATE_TOOLS` 不包含 `TASK_TOOL`，因此 teammate 不能继续派生 subagent，避免递归扩张。

工具描述中会调用 `describeSubagentsForHumans()`，把当前可用子代理类型直接暴露给模型，便于模型按任务选择合适类型。

## 子代理定义

子代理类型集中在 `src/subagents.ts` 的 `SUBAGENT_DEFINITIONS`。

### `general-purpose`

默认 worker，用于实现、编辑和聚焦子任务。

关键配置：

- `maxRounds: 30`
- `readOnlyShell: false`
- 允许使用基础文件、搜索、任务、MCP、skill 等工具
- 可使用 `write_file`、`edit_file` 修改文件

### `explore`

只读探索型 worker，用于代码搜索、行为追踪和回答实现问题。

关键配置：

- `maxRounds: 20`
- `readOnlyShell: true`
- 不允许 `write_file` / `edit_file`
- `bash` 会被运行时额外限制，只允许非变更类命令

`getSubagentDefinition(name)` 是统一入口：未传类型或传入未知类型时，会回退到第一个定义，也就是 `general-purpose`。

## 主 agent 如何派发

主 agent 的 handler 定义在 `src/agent.ts` 的 `buildLeadHandlers()` 中。

流程：

1. 从工具参数读取 `description` 和 `subagent_type`。
2. 通过 `getSubagentDefinition()` 解析子代理类型。
3. 调用 `bridge.pushTool()` 告知 UI：正在启动隔离子进程。
4. 调用 `dispatchSubagent()` 派发任务。
5. 把 `dispatchSubagent()` 返回的最终摘要作为 `subagent` 工具输出交还给主 agent。

派发给子进程的 `SubagentSpec` 包含 `subagentType`、`description`、`system`、`providerName` 和 `modelName`。其中 `system` 是当前主 agent 的基础系统提示词；`providerName` 和 `modelName` 用于子进程重新解析运行时认证和模型配置。

## 子进程启动机制

核心入口是 `src/subagent-runner.ts` 的 `dispatchSubagent()`。

父进程侧：

1. `getSubagentInvocation()` 根据当前运行文件类型决定如何重新启动 runner。
   - 开发态 `.ts/.tsx`：`node --import tsx <runner> __subagent`
   - 编译态 `.js`：`node <runner> __subagent`
2. `spawn()` 创建子进程，`stdio` 使用 `pipe`。
3. 父进程把 `SubagentSpec` JSON 写入子进程 `stdin`。
4. 父进程逐行读取子进程 `stdout`，按 JSONL 解析事件。
5. 子进程退出后，根据 result、error、exit code 决定返回文本。

文件底部有入口保护：只有命令行参数包含 `__subagent` 时，才会执行 `runSubagentHeadless()`。普通 import `dispatchSubagent()` 时不会启动子 agent。

## 子进程运行流程

子进程侧入口是 `runSubagentHeadless()`。

流程：

1. 从 `stdin` 读取并解析 `SubagentSpec`。
2. 使用 `providerName` 和 `modelName` 调用 `resolveConfig()`。
3. 读取 settings 和 credentials，并通过 `resolveRuntimeAuth()` 解析运行时认证；必要时刷新 OAuth token 并写回 credentials。
4. 通过 `buildAgentClient()` 创建 OpenAI client。
5. 使用 `getSubagentDefinition()` 获取子代理定义。
6. 拼接系统提示词：`spec.system + definition.systemPrompt`。
7. 创建 headless JSONL bridge。
8. 根据 `apiMode` 选择 Responses API loop 或 Chat Completions loop。
9. 将最终文本以 `{ type: "result", text }` 事件写到 `stdout`。

如果任意步骤抛错，会输出 `{ type: "error", message }` 并返回非零 exit code。

## 工具裁剪与只读限制

子 agent 不直接继承完整主 agent 工具集，而是通过 `buildSubagentRuntime()` 按定义裁剪：

- `responseTools`：从 `BASE_TOOLS` 中筛选 `allowedTools`
- `chatTools`：从 `BASE_CHAT_TOOLS` 中筛选 `allowedTools`
- `handlers`：从 `BASE_TOOL_HANDLERS` 中删除未授权 handler

对于 `readOnlyShell: true` 的子代理，还会包装 `bash` handler：

- 空命令会被拒绝
- 包含 `rm`、`mv`、`cp`、`mkdir`、`touch`、`chmod`、`chown` 等变更命令会被拒绝
- 包含会改变 git 状态的 `git add/commit/checkout/...` 会被拒绝
- 依赖安装/删除命令会被拒绝
- 包含重定向 `>` 或管道 `|` 的命令会被拒绝

因此 `explore` 的只读约束不只依赖 prompt，也有运行时 enforcement。

## UI 与 JSONL 事件桥接

子进程没有 Ink UI，也不能和用户交互。`createJsonlBridge()` 提供一个 headless `UiBridge`：

- `appendAssistantDelta()`、`appendThinkingDelta()`、`pushAssistant()` 等文本展示方法为空实现
- `pushTool()` 会输出 JSONL：`{ type: "tool", name, args, output }`
- `requestToolApproval()` 永远返回 `approved`
- `requestUserChoice()` 自动选择每个问题的第一个选项

父进程 `dispatchSubagent()` 收到 tool 事件后，会转发到父 UI 的 `bridge.pushTool()`，所以用户仍然能看到子 agent 的工具调用活动。

父子进程之间只传三类 JSONL 事件：

```ts
type SubagentEvent =
  | { type: "tool"; name: string; args: unknown; output: string }
  | { type: "result"; text: string }
  | { type: "error"; message: string };
```

## Responses API loop

当 `apiMode === "responses"` 时，子进程调用 `runSubagentResponses()`。

主要行为：

1. 首轮请求包含 `instructions`、用户 `input`、裁剪后的 `tools`。
2. 后续轮次使用 `previous_response_id` 延续 Responses API 链路。
3. 每轮通过 `consumeResponsesStream()` 消费模型流。
4. 如果模型返回 function call，则用 `runToolCall()` 执行工具。
5. 工具结果以 `function_call_output` 回填给下一轮。
6. 如果某轮没有工具调用，就把最终 assistant 文本返回。

轮数受子代理定义中的 `maxRounds` 限制。超过后返回：`Subagent stopped after reaching max rounds.`

## Chat Completions loop

当 `apiMode === "chat-completions"` 时，子进程调用 `runSubagentChat()`。

主要行为：

1. 初始化 `messages`：system + user。
2. 每轮调用 `consumeChatCompletionsStream()`。
3. 如果返回 `tool_calls`，先把 assistant tool call 消息加入 history。
4. 执行每个工具调用，并把结果以 `role: "tool"` 写回。
5. 如果没有工具调用，就返回 assistant 文本。

Chat Completions 路径同样使用裁剪后的 `chatTools` 和 `handlers`。

## 错误与退出处理

`dispatchSubagent()` 会处理以下情况：

- 子进程输出 `result`：返回 result 文本。
- 子进程输出 `error`：返回 `Subagent failed: ...`。
- 子进程非零退出但没有 error 事件：返回 exit code、signal 和 stderr 摘要。
- 子进程零退出但没有 result：返回 `Subagent finished without a result.`。

子进程 `stderr` 不参与协议，只作为失败诊断信息收集。

## 完整调用链

```text
主 agent 模型选择调用 subagent 工具
  -> src/agent.ts buildLeadHandlers().subagent
  -> getSubagentDefinition(subagent_type)
  -> dispatchSubagent(spec, bridge)
  -> spawn node/tsx src/subagent-runner.ts __subagent
  -> 子进程 runSubagentHeadless()
  -> buildSubagentRuntime(definition)
  -> runSubagentResponses() 或 runSubagentChat()
  -> runToolCall() 执行允许的基础工具
  -> JSONL 输出 tool/result/error
  -> 父进程转发 tool 事件并返回最终 result
  -> 主 agent 收到 subagent 工具输出并继续回答用户
```

## 设计特点

- **上下文隔离**：子 agent 从任务描述开始，不继承父对话历史。
- **进程隔离**：通过 `spawn()` 启动独立 Node 进程，崩溃不会直接中断主进程逻辑。
- **工具最小化**：按子代理定义筛选工具，`explore` 默认只读。
- **协议简单**：父子进程只通过 stdin JSON spec 和 stdout JSONL events 通信。
- **模型配置一致**：子进程使用主进程传入的 provider/model 名称重新解析配置和认证。
- **无递归派发**：subagent 使用基础工具集合，不包含 `subagent` 工具本身。

## 新增子代理类型的方法

1. 在 `src/subagents.ts` 的 `SUBAGENT_DEFINITIONS` 中新增定义。
2. 设置 `name`、`description`、`systemPrompt`、`allowedTools`、`maxRounds` 和 `readOnlyShell`。
3. 如果需要修改工具权限，只调整 `allowedTools`；runner 会自动裁剪 Responses 和 Chat Completions 两套 schema。
4. 如果是只读类型，把 `readOnlyShell` 设为 `true`，并不要把 `write_file` / `edit_file` 放进 `allowedTools`。

新增后无需修改工具 schema 的 enum；它使用 `SUBAGENT_DEFINITIONS.map((definition) => definition.name)` 自动生成。
