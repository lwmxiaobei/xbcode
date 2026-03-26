# 项目中的上下文压缩逻辑分析

本文基于当前仓库实现分析上下文压缩逻辑，核心代码位于：

- `src/compact.ts`
- `src/agent.ts`
- `src/index.tsx`
- `src/types.ts`

这套逻辑不是单一路径，而是根据 API 模式分成两类：

- `chat-completions` 模式：真正维护本地消息历史，并对历史做压缩。
- `responses` 模式：不维护完整历史，只依赖 `previousResponseId` 串联服务端上下文，所谓 compact 本质上是“断开旧链，重新开始”。

## 1. 相关状态

`AgentState` 中和上下文管理直接相关的字段定义在 `src/types.ts`：

- `previousResponseId`：Responses API 模式下的上下文链指针。
- `chatHistory`：Chat Completions 模式下的本地完整消息历史。
- `turnCount`：总轮次计数。
- `compactCount`：压缩或重置累计次数。

也就是说，这个项目并没有抽象出统一的“上下文对象”，而是按 API 模式分别维护两套上下文载体。

## 2. 压缩模块总览

`src/compact.ts` 提供了 3 个核心能力：

### 2.1 `estimateTokens(messages)`

实现很简单，使用：

```ts
Math.ceil(JSON.stringify(messages).length / 4)
```

它不是精确 tokenizer，而是一个粗略估算器，假设 `4 chars ≈ 1 token`。

用途：

- 状态栏显示当前上下文大小。
- 判断是否触发自动压缩。
- 手动 `/compact` 前后估算压缩效果。

### 2.2 `microCompact(messages)`

这是第一层压缩，目标不是总结对话，而是就地缩短旧工具结果。

规则如下：

- 只处理 `role === "tool"` 的消息。
- 永远保留最近 `3` 条工具消息原文，常量是 `KEEP_RECENT = 3`。
- 对更早的工具消息，如果 `content.length > 100`，就替换成占位符：

```txt
[Previous: used <toolName>]
```

工具名通过 `findToolName()` 倒序查找对应的 assistant `tool_calls` 取得。

这个操作是原地修改消息数组，不会生成新数组，也不会保留原始工具输出副本。

### 2.3 `autoCompact(client, model, messages)`

这是第二层压缩，目标是用模型生成摘要，然后用摘要替换整段历史。

执行步骤：

1. 先把完整历史落盘到 `.transcripts/transcript_<timestamp>.jsonl`。
2. 把整段 `messages` 做 `JSON.stringify`。
3. 只截取前 `80000` 个字符作为待总结输入。
4. 调用 `client.chat.completions.create(...)` 生成摘要。
5. 用两条新消息替换旧历史：

```ts
[
  { role: "user", content: "[Compressed conversation history]\\n\\n<summary>" },
  { role: "assistant", content: "Understood. I have the context from our previous conversation. Continuing." }
]
```

摘要 prompt 明确要求保留：

- 当前任务目标
- 已做关键决策
- 提到的文件路径
- 已完成代码修改
- 待处理事项

注意几个关键点：

- 这里固定使用 `chat.completions.create` 做摘要，不走 Responses API。
- 输入历史被截断到前 `80000` 个字符，不是“尽量保留最近消息”，而是单纯从头截断。
- 摘要最大输出是 `2000` tokens。
- 压缩后的历史只剩 2 条消息。

## 3. Chat Completions 模式下的压缩流程

这是项目里真正意义上的上下文压缩主路径。

入口在 `runAgentTurn()` 的 `apiMode === "chat-completions"` 分支。

### 3.1 每次用户发起新一轮前

执行顺序如下：

1. 清理旧 assistant 消息里的 `reasoning_content`
2. 对现有 `chatHistory` 执行一次 `microCompact`
3. 如果估算 token 超过阈值则执行 `autoCompact`
4. 把当前用户消息追加到 `chatHistory`
5. 进入 `agentLoopWithChatCompletions()`

这里的 `reasoning_content` 删除动作虽然不属于 compact 模块，但本质上也是一种上下文瘦身。注释里说明这是为了节省带宽。

### 3.2 Agent 内部多轮 tool loop 期间

`agentLoopWithChatCompletions()` 在每一轮请求前还会再次做两层检查：

1. 先 `microCompact(history)`
2. 再检查 `estimateTokens(history) > TOKEN_THRESHOLD`
3. 超限则 `autoCompact`
4. 调用模型
5. 追加 assistant 消息
6. 追加 tool 消息

也就是说，在 Chat Completions 模式下，压缩不是“每个用户回合一次”，而是：

- 进入该回合前做一次
- 该回合中每次 tool 循环前再做一次

这样设计的意义是：如果单轮任务中连续发生多次工具调用，上下文仍然有机会在中途被压缩。

### 3.3 触发阈值

阈值定义在 `src/compact.ts`：

```ts
const TOKEN_THRESHOLD = 50000;
```

触发条件是：

```ts
estimateTokens(history) > TOKEN_THRESHOLD
```

注意是严格大于，不是大于等于。

### 3.4 Chat Completions 模式的压缩后果

压缩发生后：

- 原始 `chatHistory` 被整体清空。
- 只保留“压缩摘要 + assistant 确认”两条消息。
- `state.compactCount += 1`

这意味着：

- 旧的精细上下文会丢失，只剩摘要。
- tool 输出原文、推理细节、逐步交互顺序都无法恢复。
- 但完整历史已经提前写入 `.transcripts/`，可用于离线追溯。

## 4. Responses API 模式下的“压缩”流程

这里需要特别区分：它没有对消息做摘要压缩。

`responses` 模式下，项目不维护 `chatHistory` 作为主上下文，而是依赖：

```ts
previous_response_id
```

把新请求串到前一个 response 上。

### 4.1 正常工作方式

`agentLoop()` 每一轮都会把上一轮的 `response.id` 传入下一次请求：

```ts
previous_response_id: previousResponseId
```

所以真正的上下文保存在服务端链路中。

### 4.2 自动 compact 的实际行为

`runAgentTurn()` 中定义了：

```ts
const RESPONSES_COMPACT_INTERVAL = 20;
```

当满足：

```ts
state.turnCount > 1 && (state.turnCount - 1) % RESPONSES_COMPACT_INTERVAL === 0
```

就会：

1. 在 UI 中提示 `Compacting Responses API context chain...`
2. 把 `state.previousResponseId = undefined`
3. `state.compactCount += 1`

这不生成摘要，不保存 transcript，也不把旧上下文转换成压缩文本。

它只是让下一轮请求不再接到旧 response chain 上，相当于“重开一个上下文链”。

### 4.3 这种设计的含义

优点：

- 实现非常轻。
- 不需要在客户端维护大量消息。
- 对 Responses API 的 server-side context 机制很直接。

代价：

- 到第 21、41、61... 轮时，上下文会被直接切断。
- 切断后模型拿不到任何摘要化延续信息。
- 从连续性角度看，这更像“定期清空上下文”，不是“压缩上下文”。

## 5. 手动 `/compact` 命令的行为

UI 入口在 `src/index.tsx`。

### 5.1 Chat Completions 模式

执行逻辑：

1. 计算压缩前 token 估算值。
2. 调用 `autoCompact(...)`。
3. 用摘要后的两条消息替换 `chatHistory`。
4. 增加 `compactCount`。
5. 显示 `~before -> ~after`。

因此手动 `/compact` 在这个模式下是一次真正的摘要压缩。

### 5.2 Responses 模式

执行逻辑：

1. `state.previousResponseId = undefined`
2. `compactCount += 1`
3. 显示 `Responses API context chain reset.`

这同样只是重置链路，不做摘要。

## 6. 当前实现的分层结构

从设计上看，可以把当前上下文压缩理解成 3 层：

### 6.1 第 0 层：带宽瘦身

在 Chat Completions 模式中，每轮开始前清掉旧 assistant 消息中的 `reasoning_content`。

特点：

- 不是独立模块。
- 不改变语义主线。
- 主要减少历史体积。

### 6.2 第 1 层：`microCompact`

保留消息骨架，只抹掉旧工具输出正文。

特点：

- 不调用模型。
- 成本低。
- 有损，但损失主要集中在工具输出细节。

### 6.3 第 2 层：`autoCompact`

把整段历史总结成摘要，再重建最小上下文。

特点：

- 有模型调用成本。
- 丢失大量细粒度上下文。
- 但能保留任务连续性。

Responses 模式没有这三层结构，只有“定期断链”。

## 7. 数据流示意

### 7.1 Chat Completions 模式

```txt
chatHistory
  -> 删除旧 reasoning_content
  -> microCompact(旧 tool 输出)
  -> estimateTokens
  -> 超阈值则 autoCompact
  -> push(user)
  -> 请求模型
  -> push(assistant)
  -> push(tool)
  -> 下一轮 loop 再重复上面流程
```

### 7.2 Responses 模式

```txt
query
  -> previousResponseId 串联到服务端上下文
  -> 到固定轮次后 previousResponseId = undefined
  -> 后续请求从新链开始
```

## 8. 现有限制与风险

### 8.1 `estimateTokens()` 很粗糙

它只是按 JSON 字符数粗估，适合做阈值近似判断，不适合做精确容量控制。

### 8.2 `microCompact()` 只压工具消息

不会处理：

- 冗长 assistant 文本
- 冗长 user 文本
- 大段 reasoning 摘要之外的内容

所以如果主要膨胀来自普通对话，而不是工具结果，第一层压缩效果有限。

### 8.3 `autoCompact()` 截断策略偏简单

它取的是：

```ts
JSON.stringify(messages).slice(0, 80000)
```

这意味着：

- 更早的消息优先保留。
- 更近的消息可能因为超长而被截掉。
- 这和“保留最近上下文”的直觉不完全一致。

### 8.4 摘要调用固定走 Chat Completions

即使当前主流程是 Responses API，手动或自动真正摘要压缩只在 Chat Completions 路径里出现，而且内部直接调用 `client.chat.completions.create(...)`。

这让 compact 能力和主调用模式并不完全对称。

### 8.5 Responses 模式没有连续性摘要

定期断链后，不会自动把旧链总结成一段可继承上下文，因此长期会话连续性较弱。

### 8.6 transcript 只在 `autoCompact()` 时保存

也就是说：

- Chat Completions 自动/手动摘要压缩前会留存完整历史。
- Responses 模式的链路重置不会自动落盘旧上下文。

## 9. 结论

当前项目里的“上下文压缩”其实包含两种完全不同的机制：

1. Chat Completions 模式下的真压缩
   先做旧工具输出占位化，再在超阈值时把整段历史总结为两条消息。
2. Responses 模式下的伪压缩
   不做摘要，只是在固定轮次清掉 `previousResponseId`，重建上下文链。

如果从工程意图看，这套实现的目标很明确：

- 优先用最低成本的方式延缓上下文膨胀。
- 到达阈值后再执行高成本摘要压缩。
- 在 Responses API 模式下用最简单的断链策略避免上下文无限增长。

如果后续要继续演进，这里最值得优化的方向通常会是：

- 把 Responses 模式也升级成“断链前先摘要”
- 优化 `autoCompact()` 的截断策略，优先保留最近上下文
- 让 `microCompact()` 识别更多高体积消息类型
- 使用更接近真实 tokenizer 的估算方式
