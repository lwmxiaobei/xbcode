# 从零构建 Code Agent：TypeScript 实战教程

> 本教程带你一步步构建一个类似 Claude Code 的终端 AI 编程助手。使用 TypeScript + OpenAI API + Ink（React CLI 框架）实现。

---

## 目录

### 🔵 工具与执行
- [s01 Agent 循环](#s01-agent-循环)
- [s02 工具](#s02-工具)

### 🟢 规划与协调
- [s03 TodoWrite](#s03-todowrite)（待实现）
- [s04 子 Agent](#s04-子-agent)（待实现）
- [s05 技能](#s05-技能)（待实现）
- [s07 任务系统](#s07-任务系统)（待实现）

### 🟣 内存管理
- [s06 上下文压缩](#s06-上下文压缩)（待实现）

### 🟠 并发
- [s08 后台任务](#s08-后台任务)（待实现）

### 🔴 协作
- [s09 Agent 团队](#s09-agent-团队)（待实现）
- [s10 团队协议](#s10-团队协议)（待实现）
- [s11 自主 Agent](#s11-自主-agent)（待实现）
- [s12 Worktree + 任务隔离](#s12-worktree--任务隔离)（待实现）

---

## 🔵 工具与执行

---

## s01 Agent 循环

### 核心概念

Agent 循环是整个 Code Agent 的心脏。它的本质是一个 **"思考-行动"循环**：

```
用户输入 → LLM 思考 → 调用工具 → 拿到结果 → LLM 继续思考 → ... → 最终回复
```

与普通的 ChatBot 不同，Agent 不是一问一答，而是 **自主决定** 是否需要调用工具、调用哪个工具、调用几次，直到它认为任务完成。

### 架构设计

本项目支持两种 OpenAI API 模式：

| 模式 | API | 适用场景 |
|------|-----|---------|
| `responses` | OpenAI Responses API | 原生 OpenAI（默认） |
| `chat-completions` | Chat Completions API | DeepSeek 等兼容端点 |

模式通过 `resolveApiMode()` 自动检测：

```typescript
// src/agent-tool-use-01-app.tsx:151
function resolveApiMode(): "responses" | "chat-completions" {
  const explicitMode = (process.env.OPENAI_API_MODE ?? "").trim().toLowerCase();
  if (["chat", "chat-completions", "chat_completions"].includes(explicitMode)) {
    return "chat-completions";
  }
  if (explicitMode === "responses") {
    return "responses";
  }
  // DeepSeek 等端点自动走 chat-completions
  const baseURL = (process.env.OPENAI_BASE_URL ?? "").toLowerCase();
  if (baseURL.includes("deepseek.com")) {
    return "chat-completions";
  }
  return "responses";
}
```

### 实现步骤

#### 第 1 步：定义 Agent 状态

Agent 需要在多轮对话间维持状态：

```typescript
// src/agent-tool-use-01-app.tsx:35
type AgentState = {
  previousResponseId?: string;  // Responses API 的会话链
  chatHistory: ChatMessage[];    // Chat Completions 的消息历史
  turnCount: number;             // 对话轮数
  launchedAt: number;            // 启动时间
};
```

两种 API 的状态管理策略不同：
- **Responses API**：通过 `previousResponseId` 链式关联，服务端保存上下文
- **Chat Completions**：客户端自己维护完整的 `chatHistory`

#### 第 2 步：实现 Agent 循环（Responses API）

这是核心循环，注意 `while (true)` —— 它会持续运行直到 LLM 不再请求工具调用：

```typescript
// src/agent-tool-use-01-app.tsx:374
async function agentLoop(
  query: string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
): Promise<string | undefined> {
  // 第一轮输入是用户消息
  let nextInput: ResponseInputItem[] | string = [
    { role: "user", content: [{ type: "input_text", text: query }] },
  ];
  let currentResponseId = previousResponseId;

  while (true) {
    // 1. 调用 LLM，流式输出
    const response = await streamResponse(nextInput, currentResponseId, bridge);
    currentResponseId = response.id;

    // 2. 检查是否有工具调用
    const toolCalls = Array.isArray(response.output)
      ? response.output.filter((item: any) => item.type === "function_call")
      : [];

    // 3. 没有工具调用 → 循环结束，返回最终回复
    if (toolCalls.length === 0) {
      return currentResponseId;
    }

    // 4. 有工具调用 → 执行工具，把结果作为下一轮输入
    const results: ResponseInputItem[] = [];
    for (const toolCall of toolCalls) {
      results.push(await runToolCall(toolCall, bridge));
    }
    nextInput = results;
  }
}
```

**关键设计点：**
- 循环终止条件：LLM 返回的 output 中没有 `function_call` 类型的项
- 工具结果通过 `function_call_output` 类型反馈给 LLM
- `previousResponseId` 让 API 服务端知道上下文链

#### 第 3 步：实现 Agent 循环（Chat Completions API）

Chat Completions 模式下，客户端需要自己管理消息历史：

```typescript
// src/agent-tool-use-01-app.tsx:408
async function agentLoopWithChatCompletions(
  history: ChatMessage[],
  bridge: UiBridge,
): Promise<void> {
  while (true) {
    // 1. 发送完整历史给 LLM
    const completion = await createChatCompletion(history);
    const message = completion.choices?.[0]?.message;

    // 2. 处理文本回复
    const assistantText = extractAssistantText(message.content);
    if (assistantText.trim()) {
      bridge.pushAssistant(assistantText.trim());
    }

    // 3. 把 assistant 消息加入历史
    history.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls ?? undefined,
    });

    // 4. 检查工具调用
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (toolCalls.length === 0) return;

    // 5. 执行工具，结果加入历史
    for (const toolCall of toolCalls) {
      const name = String(toolCall.function?.name ?? "unknown_tool");
      const args = safeJsonParse(String(toolCall.function?.arguments ?? "{}"));
      const handler = TOOL_HANDLERS[name];
      const outputText = handler ? await handler(args) : `Unknown tool: ${name}`;
      bridge.pushTool(name, args, outputText);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: outputText,
      });
    }
  }
}
```

#### 第 4 步：统一入口

`runAgentTurn` 统一了两种 API 模式的入口：

```typescript
// src/agent-tool-use-01-app.tsx:449
async function runAgentTurn(
  query: string,
  state: AgentState,
  bridge: UiBridge,
): Promise<void> {
  state.turnCount += 1;
  if (API_MODE === "chat-completions") {
    state.chatHistory.push({ role: "user", content: query });
    await agentLoopWithChatCompletions(state.chatHistory, bridge);
    return;
  }
  state.previousResponseId = await agentLoop(query, state.previousResponseId, bridge);
}
```

#### 第 5 步：流式输出

流式输出让用户实时看到 LLM 的思考过程：

```typescript
// src/agent-tool-use-01-app.tsx:315
async function streamResponse(
  inputItems: ResponseInputItem[] | string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
): Promise<any> {
  const stream = client.responses.stream({
    model: MODEL,
    instructions: SYSTEM,
    input: inputItems as any,
    previous_response_id: previousResponseId,
    tools: TOOLS as any,
  });

  for await (const event of stream as AsyncIterable<any>) {
    // 文本 delta → 实时显示
    if (event.type === "response.output_text.delta") {
      bridge.appendAssistantDelta(String(event.delta ?? ""));
      continue;
    }
    // 思考过程 delta（可选显示）
    if (SHOW_THINKING && ["response.reasoning_summary_text.delta",
        "response.reasoning_text.delta"].includes(event.type)) {
      bridge.appendThinkingDelta(String(event.delta ?? ""));
      continue;
    }
    // 工具调用开始 → 结束当前文本流
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      bridge.finalizeStreaming();
    }
  }

  const response = await stream.finalResponse();
  bridge.finalizeStreaming();
  return response;
}
```

### Agent 循环流程图

```
┌─────────────┐
│  用户输入    │
└──────┬──────┘
       ▼
┌──────────────┐
│  调用 LLM    │◄──────────────┐
│  (流式输出)   │               │
└──────┬───────┘               │
       ▼                       │
┌──────────────┐               │
│ 有工具调用？  │               │
└──┬────┬──────┘               │
   │    │                      │
  Yes   No                     │
   │    │                      │
   ▼    ▼                      │
┌────┐ ┌──────────┐            │
│执行│ │ 返回最终  │            │
│工具│ │ 回复      │            │
└──┬─┘ └──────────┘            │
   │                           │
   │  工具结果作为下轮输入       │
   └───────────────────────────┘
```

---

## s02 工具

### 核心概念

工具（Tools）是 Agent 与外部世界交互的桥梁。没有工具，LLM 只能"说"；有了工具，它能"做"。

一个 Code Agent 最基本的工具集是：
1. **bash** — 执行 shell 命令
2. **read_file** — 读取文件
3. **write_file** — 写入文件
4. **edit_file** — 编辑文件（精确替换）

### 实现步骤

#### 第 1 步：定义工具 Schema

工具需要以 JSON Schema 格式描述，让 LLM 知道有哪些工具可用、参数是什么：

```typescript
// src/agent-tool-use-01-app.tsx:72
const TOOLS = [
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
  {
    type: "function",
    name: "read_file",
    description: "Read file contents.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        limit: { type: "integer" },  // 可选：限制读取行数
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "write_file",
    description: "Write content to file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "edit_file",
    description: "Replace exact text in file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
] as const;
```

**设计要点：**
- `additionalProperties: false` 阻止 LLM 传入未定义的参数
- `description` 要简洁明确，LLM 靠它决定何时使用哪个工具
- `required` 明确必填参数

#### 第 2 步：工具分发器

用一个 map 将工具名映射到执行函数：

```typescript
// src/agent-tool-use-01-app.tsx:140
const TOOL_HANDLERS: Record<string, (args: ToolArgs) => Promise<string> | string> = {
  bash:       ({ command }) => runBash(String(command)),
  read_file:  ({ path: filePath, limit }) => runRead(String(filePath), toOptionalNumber(limit)),
  write_file: ({ path: filePath, content }) => runWrite(String(filePath), String(content)),
  edit_file:  ({ path: filePath, old_text, new_text }) =>
                runEdit(String(filePath), String(old_text), String(new_text)),
};
```

工具调用的处理流程：

```typescript
// src/agent-tool-use-01-app.tsx:358
async function runToolCall(toolCall: any, bridge: UiBridge): Promise<ResponseInputItem> {
  const name = String(toolCall.name ?? toolCall.function?.name ?? "unknown_tool");
  const rawArgs = String(toolCall.arguments ?? toolCall.function?.arguments ?? "{}");
  const args = safeJsonParse(rawArgs);

  const handler = TOOL_HANDLERS[name];
  const outputText = handler ? await handler(args) : `Unknown tool: ${name}`;
  bridge.pushTool(name, args, outputText);

  return {
    type: "function_call_output",
    call_id: toolCall.call_id,
    output: outputText,
  };
}
```

#### 第 3 步：实现 bash 工具

bash 是最强大也最危险的工具，需要安全防护：

```typescript
// src/agent-tool-use-01-app.tsx:202
async function runBash(command: string): Promise<string> {
  // 安全检查：阻止危险命令
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((snippet) => command.includes(snippet))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,            // 在工作目录执行
      timeout: 120_000,         // 120 秒超时
      maxBuffer: 1024 * 1024 * 10,  // 10MB 输出缓冲
      shell: process.env.SHELL, // 使用用户的 shell
    });
    const combined = `${stdout}${stderr}`.trim();
    return combined ? combined.slice(0, 50_000) : "(no output)";
  } catch (error) {
    if (isExecTimeout(error)) {
      return "Error: Timeout (120s)";
    }
    const execError = toExecError(error);
    const combined = `${execError.stdout ?? ""}${execError.stderr ?? ""}`.trim();
    return combined ? combined.slice(0, 50_000) : `Error: ${String(error)}`;
  }
}
```

**安全设计：**
- 危险命令黑名单
- 执行超时保护（120秒）
- 输出大小限制（50K 字符）
- 错误也返回文本而非抛异常（让 Agent 能自行处理错误）

#### 第 4 步：实现文件操作工具

**路径安全**——所有文件操作都必须通过 `safePath` 防止路径逃逸：

```typescript
// src/agent-tool-use-01-app.tsx:193
function safePath(relativePath: string): string {
  const resolved = path.resolve(WORKDIR, relativePath);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return resolved;
}
```

**read_file** — 支持行数限制：

```typescript
// src/agent-tool-use-01-app.tsx:239
function runRead(filePath: string, limit?: number): string {
  try {
    const text = fs.readFileSync(safePath(filePath), "utf8");
    let lines = text.split(/\r?\n/);
    if (limit && limit < lines.length) {
      lines = [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`];
    }
    return lines.join("\n").slice(0, 50_000);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

**write_file** — 自动创建目录：

```typescript
// src/agent-tool-use-01-app.tsx:252
function runWrite(filePath: string, content: string): string {
  try {
    const fullPath = safePath(filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

**edit_file** — 精确文本替换（而非行号替换）：

```typescript
// src/agent-tool-use-01-app.tsx:263
function runEdit(filePath: string, oldText: string, newText: string): string {
  try {
    const fullPath = safePath(filePath);
    const content = fs.readFileSync(fullPath, "utf8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${filePath}`;
    }
    fs.writeFileSync(fullPath, content.replace(oldText, newText), "utf8");
    return `Edited ${filePath}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

**为什么用文本匹配而非行号？** 因为 LLM 计算行号经常出错，而精确文本匹配更可靠。这也是 Claude Code 的设计思路。

### 工具设计原则总结

| 原则 | 说明 |
|------|------|
| **返回字符串** | 所有工具统一返回字符串，LLM 容易理解 |
| **错误不抛异常** | 返回 `Error: ...` 字符串，让 Agent 自行决定如何处理 |
| **输出截断** | 防止超长输出撑爆上下文窗口（50K 字符限制） |
| **路径沙箱** | `safePath` 确保文件操作不逃出工作目录 |
| **命令黑名单** | 阻止明显的破坏性 shell 命令 |
| **超时保护** | 防止命令挂起导致 Agent 卡死 |

### 终端 UI（附加知识）

本项目使用 **Ink**（React for CLI）构建终端界面，提供了类似 Claude Code 的交互体验：

- 信任确认提示（TrustPrompt）
- 流式文本输出
- 工具调用可视化（名称、参数、结果）
- 斜杠命令菜单（`/help`、`/status`、`/clear`、`/exit`）
- 自适应终端尺寸

UiBridge 是 Agent 循环与 UI 层的桥梁：

```typescript
type UiBridge = {
  appendAssistantDelta(delta: string): void;   // 流式追加文本
  appendThinkingDelta(delta: string): void;    // 流式追加思考过程
  finalizeStreaming(): void;                    // 结束当前流式消息
  pushAssistant(text: string): void;           // 推送完整助手消息
  pushTool(name: string, args: ToolArgs, result: string): void;  // 推送工具调用记录
};
```

---

## 🟢 规划与协调

---

## s03 TodoWrite

> 待实现

TodoWrite 是 Agent 的任务规划工具。它让 Agent 能够将复杂任务分解为可跟踪的步骤列表，并在执行过程中更新进度。类似 Claude Code 中的任务清单功能。

---

## s04 子 Agent

> 待实现

子 Agent（Sub-Agent）允许主 Agent 派生子任务给独立的 Agent 实例处理。每个子 Agent 有自己的上下文窗口和工具集，适合处理需要深入探索但不应污染主上下文的任务。

---

## s05 技能

> 待实现

技能（Skills）是预定义的 prompt 模板和工作流，Agent 可以在特定场景下调用。类似 Claude Code 的 Skill 系统，可以为特定任务领域提供专业化的指导。

---

## s07 任务系统

> 待实现

任务系统在 TodoWrite 基础上进一步扩展，提供持久化的任务管理、状态追踪、依赖关系等功能。

---

## 🟣 内存管理

---

## s06 上下文压缩

> 待实现

当对话历史变得过长时，上下文压缩会自动摘要早期消息，保持窗口内信息密度。这对于长时间运行的 Agent 会话至关重要。

---

## 🟠 并发

---

## s08 后台任务

> 待实现

后台任务允许 Agent 将耗时操作（如构建、测试）放到后台执行，同时继续与用户交互。任务完成时通知用户。

---

## 🔴 协作

---

## s09 Agent 团队

> 待实现

多个 Agent 实例协同工作，每个 Agent 有不同的专长和角色（如代码审查专家、测试专家、架构师等）。

---

## s10 团队协议

> 待实现

定义 Agent 之间的通信协议和协作规范，确保多 Agent 系统的有序运转。

---

## s11 自主 Agent

> 待实现

自主 Agent 能够独立规划和执行复杂任务，无需持续的用户输入。包括目标分解、自我纠错、进度汇报等能力。

---

## s12 Worktree + 任务隔离

> 待实现

利用 Git Worktree 为每个任务创建隔离的工作副本，避免并行任务之间的文件冲突。任务完成后将变更合并回主分支。
