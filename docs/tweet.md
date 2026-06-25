# xbcode 推文文案

两个版本，可按场景挑选。

---

## 版本 1：单条推文（中文，~270 字）

🚀 开源新项目：**xbcode** — 一个用 TypeScript 写的极简 CLI 编码 Agent

把 Codex / Claude Code 那一套压缩到能一口气读完的代码量，但功能不缩水：

✅ 终端 UI（Ink + React）流式输出
✅ 内置 bash / read / write / edit / task 工具
✅ 持久化任务板（.tasks/）
✅ Skills 系统（兼容 ~/.claude/skills）
✅ MCP 集成（stdio + streamable-http）
✅ 多 Agent 协作（持久化 teammate + inbox）
✅ 双 API 模式：OpenAI Responses / Chat Completions
✅ 支持火山引擎、阿里云、DeepSeek 等兼容端点

```bash
npm i -g @lwmxiaobei/xbcode
xbcode
```

适合想读懂 Coding Agent 内部原理、又能日常拿来用的开发者。

GitHub: github.com/lwmxiaobei/xbcode

#OpenSource #AIAgent #MCP #TypeScript

---

## 版本 2：Twitter Thread（中文，6 条）

**1/6**
做了个开源小项目：**xbcode** 🛠️

一个 TypeScript 写的 CLI 编码 Agent，定位是「**能一口气读完源码的 Codex 平替**」——足够小、足够 hackable，但已经够日常用。

`npm i -g @lwmxiaobei/xbcode`

🔗 github.com/lwmxiaobei/xbcode

**2/6**
🧠 核心是一个标准的 think-act 循环：
拼 system prompt → 调模型 → 流式渲染 → 执行工具 → 把结果喂回去 → 直到模型不再要工具。

同时支持两种后端：
• OpenAI **Responses API**（用 previous_response_id 串接）
• **Chat Completions**（兼容 DeepSeek / 通义 / 火山 Ark 等）

**3/6**
🧰 内置工具开箱即用：
`bash` / `read_file` / `write_file` / `edit_file` / `task`

其中 `task` 会派发到一个**干净上下文的子 Agent**，避免主线被噪音淹没。文件工具不沙箱化，但写操作走审批，bash 有超时和危险命令拦截。

**4/6**
📋 任务、技能、MCP 全都有：

• **任务板**：文件持久化在 `.tasks/`，支持依赖关系，完成后自动解锁后继任务
• **Skills**：兼容 `~/.claude/skills`，本地 skills 可覆盖全局
• **MCP**：stdio + streamable-http，工具/资源/Prompt 全打通

**5/6**
👥 还有「团队模式」：
不是一次性子 Agent，而是**持久化的 teammate**，每个有自己的身份、收件箱、wake/sleep 生命周期。

通过 append-only 的 inbox 文件做异步协作，上下文天然隔离。

`teammate_spawn` / `message_send` / `lead_inbox`

**6/6**
为什么要再做一个？

因为现有 Coding Agent 要么闭源、要么大到读不动。xbcode 刻意保持小：
• 直接组合 > 深层抽象
• 文件持久化 > 数据库
• 显式模块 > 框架编排

适合想**搞懂 Agent 内部原理**、又想顺手用的开发者。欢迎 Star / PR 🙌
