# Agent Loop 新手教程

本教程将带你理解 Agent Loop（智能体循环）的核心概念，并结合本项目的实际代码进行讲解。

## 目录

- [什么是 Agent Loop](#什么是-agent-loop)
- [核心思想：思考-行动循环](#核心思想思考-行动循环)
- [整体架构](#整体架构)
- [核心实现详解](#核心实现详解)
- [两种 API 模式](#两种-api-模式)
- [工具系统](#工具系统)
- [子代理机制](#子代理机制)
- [上下文管理](#上下文管理)
- [完整流程图](#完整流程图)

---

## 什么是 Agent Loop

Agent Loop 是 AI Agent 的核心运行机制。它让 LLM（大语言模型）能够：

1. **接收**用户的请求
2. **思考**需要做什么
3. **调用工具**来执行操作
4. **观察**工具返回的结果
5. **继续思考**或返回最终答案

简单来说，Agent Loop 就是一个让 AI 能够"做事"而不仅仅是"说话"的循环。

---

## 核心思想：思考-行动循环

```
┌─────────────────────────────────────────────────────────┐
│                     Agent Loop                          │
│                                                         │
│   用户请求                                              │
│      │                                                  │
│      ▼                                                  │
│   ┌──────────┐    有工具调用    ┌──────────────┐        │
│   │  LLM 思考 │ ◄─────────────► │ 执行工具并返回 │        │
│   └──────────┘                  └──────────────┘        │
│      │                                                  │
│      │ 无工具调用                                        │
│      ▼                                                  │
│   返回结果给用户                                         │
└─────────────────────────────────────────────────────────┘
```

关键点：
- **循环**：LLM 可以多次调用工具，直到任务完成
- **自主决策**：LLM 自己决定何时调用工具、调用哪个工具
- **工具反馈**：工具的执行结果会反馈给 LLM，影响后续决策

---

## 整体架构

本项目的 Agent Loop 主要由以下文件组成：

```
src/
├── agent.ts          # 核心 Agent Loop 实现
├── types.ts          # 类型定义
├── tools.ts          # 工具定义和执行
├── subagents.ts      # 子代理类型定义
└── compact.ts        # 上下文压缩
```

核心函数调用关系：

```
runTurn()                    # 统一入口
    │
    ├── agentLoop()          # Responses API 模式
    │       │
    │       ├── streamResponse()      # 流式调用 API
    │       ├── runToolCall()         # 执行工具
    │       └── 循环直到无工具调用
    │
    └── agentLoopWithChatCompletions()  # Chat Completions 模式
            │
            ├── streamChatCompletion()   # 流式调用 API
            ├── runToolCall()            # 执行工具
            └── 循环直到无工具调用
```

---

## 核心实现详解

### 1. AgentState：会话状态

```typescript
export type AgentState = {
  sessionId: string;                    // 会话 ID
  previousResponseId?: string;          // Responses API 链式调用用
  responseHistory: ResponseInputItem[]; // Responses API 历史
  chatHistory: ChatMessage[];           // Chat Completions 历史
  pendingCompactedContext?: string;     // 待注入的压缩摘要
  turnCount: number;                    // 当前轮次
  launchedAt: number;                   // 启动时间
  roundsSinceTask: number;             # 自上次任务以来的轮次
  compactCount: number;                 # 压缩次数
};
```

`AgentState` 保存了整个会话的状态。两种 API 模式使用不同的字段：
- **Responses API**：使用 `previousResponseId` 链式调用，OpenAI 服务端保存历史
- **Chat Completions**：使用 `chatHistory` 数组，客户端保存完整历史

### 2. runTurn()：统一入口

```typescript
export async function runTurn(
  userText: string,
  state: AgentState,
  ui: UiBridge,
  abortSignal?: AbortSignal,
): Promise<string>
```

`runTurn` 是外部调用的统一入口，它：

1. 检测当前应该使用哪种 API 模式
2. 根据模式调用对应的 Agent Loop
3. 返回最终的响应文本

关键代码：

```typescript
const effectiveMode = detectMode();
const isResponses = effectiveMode === "responses";

if (isResponses) {
  // Responses API 模式
  const result = await agentLoop({ ... });
} else {
  // Chat Completions 模式
  const result = await agentLoopWithChatCompletions({ ... });
}
```

### 3. agentLoop()：Responses API 核心循环

这是 Agent Loop 的核心实现，让我们逐段分析：

```typescript
async function agentLoop({
  prompt,
  state,
  ui,
  tools,
  toolHandlers,
  agentLabel,
  maxRounds,
  abortSignal,
  notifyActivity,
  taskContext,
}: AgentLoopOptions): Promise<AgentLoopResult>
```

#### 初始化阶段

```typescript
const roundsSinceTask = state.roundsSinceTask ?? 0;
const MAX_ROUNDS_SINCE_TASK = 100;
const MAX_RESPONSE_INPUT = 200;
const DEDUP_WINDOW = 10;

state.roundsSinceTask = roundsSinceTask + 1;

if (roundsSinceTask >= MAX_ROUNDS_SINCE_TASK) {
  return { output: "ERROR: runaway agent (no task_progress in 100 rounds)" };
}
```

这段代码实现了**防跑飞机制**：如果连续 100 轮都没有报告任务进度，就强制终止循环。

#### 构建输入

```typescript
const input: ResponseInputItem[] = [
  ...state.responseHistory,
  { role: "user", content: prompt },
];
```

将历史记录和新的用户输入合并成完整的上下文。

#### 主循环

```typescript
while (!aborted) {
  // 1. 流式调用 API
  const apiResult = await streamResponse(
    effectiveInput,
    state.previousResponseId,
    effectiveTools,
    ui,
    notifyActivity,
    abortSignal,
  );

  // 2. 处理响应
  const outputItems = apiResult.output;
  state.previousResponseId = apiResult.id;

  // 3. 分离文本输出和工具调用
  let toolCalls = [];
  let textOutput = "";

  for (const item of outputItems) {
    if (item.type === "function_call") {
      toolCalls.push(item);
    } else if (item.type === "message") {
      textOutput += extractMessageText(item);
    }
  }

  // 4. 如果没有工具调用，循环结束
  if (toolCalls.length === 0) {
    break;
  }

  // 5. 执行所有工具调用
  const toolResults = [];
  for (const toolCall of toolCalls) {
    const result = await runToolCall(toolCall, toolHandlers, ui, abortSignal);
    toolResults.push(result);
  }

  // 6. 将工具结果加入输入，继续循环
  effectiveInput = [...effectiveInput, ...outputItems, ...toolResults];
}
```

这个循环的核心逻辑：
1. 调用 LLM 获取响应
2. 检查是否有工具调用
3. 如果有，执行工具并将结果反馈给 LLM
4. 重复直到 LLM 不再调用工具

### 4. runToolCall()：工具执行

```typescript
async function runToolCall(
  item: ResponseInputItem,
  handlers: ToolHandlers,
  ui: UiBridge,
  signal?: AbortSignal,
): Promise<Extract<ResponseInputItem, { type: "function_call_output" }>>
```

工具执行的流程：

```typescript
// 1. 解析工具调用信息
const callId = item.call_id ?? item.id ?? randomUUID();
const toolName = item.name;
const rawArgs = item.arguments ?? "{}";

// 2. 解析参数
let args: Record<string, unknown>;
try {
  args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : (rawArgs ?? {});
} catch {
  args = {};
}

// 3. 查找并执行工具
const handler = handlers[toolName];
let output: string;
if (handler) {
  output = await handler(args, { signal });
} else {
  output = `Error: unknown tool ${toolName}`;
}

// 4. 更新 UI
ui.pushTool(toolName, args, output);

// 5. 返回工具执行结果
return {
  type: "function_call_output",
  call_id: callId,
  output,
};
```

### 5. streamResponse()：流式 API 调用

```typescript
async function streamResponse(
  input: ResponseInputItem[],
  previousResponseId: string | undefined,
  tools: readonly object[],
  ui: UiBridge,
  notifyActivity?: () => void,
  signal?: AbortSignal,
): Promise<ApiResponse>
```

这个函数负责：
1. 调用 OpenAI Responses API
2. 流式处理响应（文本、工具调用、推理）
3. 更新 UI 显示

```typescript
const stream = await client.responses.create({
  model: effectiveModel,
  input,
  tools,
  stream: true,
  ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
});

for await (const event of stream) {
  // 处理不同类型的事件
  if (event.type === "response.output_text.delta") {
    ui.appendAssistantDelta(event.delta);
  } else if (event.type === "response.output_item.done") {
    outputItems.push(event.item);
  }
  // ... 更多事件类型
}
```

---

## 两种 API 模式

本项目支持两种 OpenAI API 模式，以兼容不同的服务提供商：

### Responses API（默认）

OpenAI 的新 API，特点：
- 服务端保存对话历史
- 通过 `previous_response_id` 链式调用
- 更简洁的状态管理

```typescript
// Responses API 调用示例
const response = await client.responses.create({
  model: "gpt-4",
  input: [...messages],
  previous_response_id: "resp_abc123",  // 链接到上一轮
  tools: [...],
});
```

### Chat Completions API

传统 API，兼容 DeepSeek 等第三方服务，特点：
- 客户端保存完整历史
- 每次请求发送完整消息列表
- 更广泛的兼容性

```typescript
// Chat Completions 调用示例
const response = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [...history, { role: "user", content: prompt }],
  tools: [...],
});
```

### 模式自动检测

```typescript
function detectMode(): "responses" | "chat-completions" {
  // 1. 显式配置优先
  const apiMode = process.env.OPENAI_API_MODE?.toLowerCase();
  if (apiMode === "chat-completions") return "chat-completions";
  if (apiMode === "responses") return "responses";

  // 2. 非 OpenAI 端点默认用 Chat Completions
  const baseUrl = process.env.OPENAI_BASE_URL?.toLowerCase() ?? "";
  const isNonOpenAi =
    baseUrl.includes("deepseek") ||
    baseUrl.includes("openrouter") ||
    !baseUrl.includes("api.openai.com");

  if (isNonOpenAi) return "chat-completions";

  // 3. OpenAI 端点默认用 Responses
  return "responses";
}
```

---

## 工具系统

### 工具定义

每个工具都有 JSON Schema 格式的定义：

```typescript
export const BASE_TOOLS = [
  {
    type: "function",
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  // ... 更多工具
];
```

### 工具处理器

工具处理器是一个函数映射表：

```typescript
export const BASE_TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: ({ command }, control) => runBash(String(command), control?.signal),
  read_file: ({ path, limit }) => runRead(String(path), toOptionalNumber(limit)),
  write_file: ({ path, content }) => runWrite(String(path), String(content)),
  // ... 更多处理器
};
```

### 内置工具列表

| 工具名 | 功能 | 特点 |
|--------|------|------|
| `bash` | 执行 shell 命令 | 危险命令拦截、120s 超时 |
| `read_file` | 读取文件 | 支持行数限制 |
| `write_file` | 写入文件 | 自动创建目录 |
| `edit_file` | 编辑文件 | 精确文本替换 |
| `glob` | 文件查找 | 基于 ripgrep，尊重 .gitignore |
| `grep` | 内容搜索 | 支持正则、输出截断 |
| `web_fetch` | 获取网页 | 自动 HTTPS 升级、HTML 转文本 |
| `task` | 派生子代理 | 主 agent 独有 |

### 安全机制：危险命令拦截

```typescript
const DANGEROUS_COMMAND_PATTERNS = [
  {
    pattern: /rm\s+.*\/(?:etc|usr|var|home)/,
    reason: "rm targeting system directory",
  },
  {
    pattern: /sudo/,
    reason: "sudo (privilege escalation)",
  },
  // ... 更多模式
];

export function detectDangerousCommand(command: string): string | null {
  const normalized = command.replace(/\s+/g, " ").trim();
  for (const { pattern, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(normalized)) return reason;
  }
  return null;
}
```

### 输出截断

工具输出会被截断以防止上下文溢出：

```typescript
const TOOL_OUTPUT_MAX_BYTES = 50_000;

export function appendTruncationNotice(content: string, maxBytes: number): string {
  if (content.length <= maxBytes) return content;
  const kept = content.slice(0, maxBytes);
  const dropped = content.slice(maxBytes);
  const remainingLines = (dropped.match(/\n/g)?.length ?? 0) + 1;
  return `${kept}\n\n... [${remainingLines} lines truncated] ...`;
}
```

---

## 子代理机制

### 什么是子代理

子代理是主 Agent 派生的独立工作者，用于：
- 执行复杂任务的子任务
- 探索代码库（explore 子代理）
- 并行处理多个独立任务

### 子代理类型

```typescript
const SUBAGENT_DEFINITIONS = [
  {
    type: "general-purpose",
    label: "general-purpose",
    description: "Default worker for implementation, editing, and focused subtasks.",
    tools: BASE_TOOLS,      // 只有基础工具
    maxRounds: 30,          // 最多 30 轮
  },
  {
    type: "explore",
    label: "explore",
    description: "Read-only codebase exploration.",
    tools: READ_ONLY_TOOLS, // 只有读取工具
    maxRounds: 30,
  },
];
```

### 子代理的工具限制

子代理**不能**使用：
- `task` 工具（不能派生孙子代理）
- 团队协作工具（`message_send`、`teammate_spawn` 等）

这防止了：
- 无限递归派生
- 权限扩散

### 子代理循环实现

```typescript
export async function subAgentLoopResponses({
  taskDescription,
  def,
  ui,
  contextMessages,
  abortSignal,
  notifyActivity,
  taskContext,
}: SubAgentLoopOptions): Promise<SubAgentLoopResult> {
  const state = createCleanState();

  const prompt = contextMessages
    ? `${contextMessages}\n\n---\n\nTask: ${taskDescription}`
    : taskDescription;

  const result = await agentLoop({
    prompt,
    state,
    ui,
    tools: def.tools,
    toolHandlers: def.toolHandlers ?? BASE_TOOL_HANDLERS,
    agentLabel: def.label ?? def.type,
    maxRounds: def.maxRounds ?? 30,
    abortSignal,
    notifyActivity,
    taskContext,
  });

  return { output: result.output, state };
}
```

子代理使用独立的 `createCleanState()` 创建全新的状态，不继承父代理的历史。

---

## 上下文管理

### 问题：上下文窗口溢出

随着对话进行，消息历史会越来越长，最终可能超出模型的上下文窗口限制。

### 解决方案：自动压缩

当 token 使用量超过阈值时，自动触发上下文压缩：

```typescript
const AUTO_COMPACT_THRESHOLD = 0.7; // 70% 阈值

if (usageRatio >= AUTO_COMPACT_THRESHOLD) {
  const trigger =
    usageRatio >= 1.0
      ? { mode: "hard" as const }
      : { mode: "soft" as const, category };

  const result = await autoCompact(state, trigger);
}
```

### 压缩流程

```typescript
export async function autoCompact(
  state: AgentState,
  trigger: CompactTrigger,
): Promise<CompactResult> {
  // 1. 确定压缩目标
  const target = determineTarget(state, trigger);

  // 2. 生成摘要
  const summary = await generateSummary(state, target);

  // 3. 替换历史
  replaceHistory(state, summary, target.keepLast);

  // 4. 记录压缩事件
  state.compactCount++;

  return { summary, removedCount: target.removeCount };
}
```

### 压缩级别

- **Level 1**：仅保留系统提示 + 最近消息（激进）
- **Level 2**：保留系统提示 + 任务摘要 + 最近消息（平衡）
- **Level 3**：保留系统提示 + 详细摘要 + 更多最近消息（保守）

### 压缩上下文注入

压缩后，会在下一轮对话开头注入压缩摘要：

```typescript
if (state.pendingCompactedContext) {
  const compactedContext = state.pendingCompactedContext;
  state.pendingCompactedContext = undefined;
  prompt = `${compactedContext}\n\n---\n\n${prompt}`;
}
```

---

## 完整流程图

```
用户输入 "帮我写一个 hello world 程序"
         │
         ▼
    ┌─────────────┐
    │   runTurn()  │
    └─────────────┘
         │
         ▼
    ┌─────────────────┐
    │ detectMode()    │
    │ → "responses"   │
    └─────────────────┘
         │
         ▼
    ┌─────────────────┐
    │  agentLoop()    │
    │                 │
    │  Round 1:       │
    │  ├─ LLM 思考    │
    │  │  "我需要创建  │
    │  │   一个文件"   │
    │  │              │
    │  ├─ 工具调用:   │
    │  │  write_file  │
    │  │  {           │
    │  │    path:     │
    │  │    "hello.js",│
    │  │    content:  │
    │  │    "console..│
    │  │  }           │
    │  │              │
    │  ├─ 执行工具    │
    │  │  → "Wrote 45 │
    │  │    bytes"    │
    │  │              │
    │  └─ 继续循环    │
    │                 │
    │  Round 2:       │
    │  ├─ LLM 思考    │
    │  │  "文件已创建，│
    │  │   任务完成"   │
    │  │              │
    │  └─ 无工具调用  │
    │     → 循环结束  │
    └─────────────────┘
         │
         ▼
    "已创建 hello.js，│
     内容如下：..."
         │
         ▼
      返回给用户
```

---

## 关键设计要点总结

### 1. 循环控制
- **最大轮次限制**：防止无限循环
- **防跑飞机制**：连续 N 轮无进展则终止
- **中止信号**：支持外部中止（`AbortSignal`）

### 2. 状态管理
- **分离关注点**：两种 API 模式使用不同状态字段
- **链式调用**：Responses API 通过 ID 链接历史
- **完整历史**：Chat Completions 保存完整消息列表

### 3. 工具系统
- **声明式定义**：JSON Schema 描述工具接口
- **安全拦截**：危险命令检测
- **输出截断**：防止上下文溢出

### 4. 子代理
- **独立状态**：不继承父代理历史
- **权限限制**：不能递归派生
- **轮次限制**：最多 30 轮

### 5. 上下文管理
- **自动压缩**：基于 token 使用率触发
- **多级策略**：激进到保守的压缩选项
- **摘要注入**：压缩后自动注入上下文

---

## 进阶阅读

- [OpenAI Responses API 文档](https://platform.openai.com/docs/api-reference/responses)
- [OpenAI Chat Completions API 文档](https://platform.openai.com/docs/api-reference/chat)
- [ReAct 论文](https://arxiv.org/abs/2210.03629)：Agent Loop 的理论基础
- [Tool Use 最佳实践](https://platform.openai.com/docs/guides/function-calling)

---

## 总结

Agent Loop 是让 LLM 从"聊天机器人"升级为"智能助手"的核心机制。通过本教程，你应该理解了：

1. **循环本质**：思考-行动-观察的持续循环
2. **工具调用**：LLM 如何决定和执行工具
3. **状态管理**：如何维护对话历史
4. **安全机制**：如何防止危险操作
5. **扩展能力**：如何通过子代理处理复杂任务

掌握这些概念后，你就能更好地理解和使用 AI Agent，甚至开发自己的 Agent 系统。
