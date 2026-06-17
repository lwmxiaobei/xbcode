[English](./README.md) | [简体中文](./README.zh-CN.md)

# xbcode

`xbcode` 是一个基于 TypeScript、OpenAI SDK 和 Ink 构建的终端代码代理。它运行在命令行中，支持流式输出、本地工具调用、持久化任务、技能加载、MCP 集成，以及轻量级多 Agent 协作。

这个项目的目标不是做一个“什么都包”的庞大框架，而是提供一个足够实用、同时又足够小巧、便于阅读和改造的 CLI Agent 实现。

## 特性概览

- 基于 Ink + React 的终端交互界面
- 同时支持 Responses API 和 Chat Completions API
- 面向本机路径和当前工作目录的文件与命令工具
- 持久化任务系统，任务保存在 `.tasks/`
- 支持全局技能和仓库本地技能
- 支持 MCP server 接入
- 支持持久化 teammate 协作
- 支持长对话上下文压缩
- 代码结构清晰，适合继续二次开发

## 快速开始

### 安装

```bash
npm install -g @lwmxiaobei/xbcode
```

或者在当前仓库本地运行：

```bash
npm install
npm run dev
```

### 首次配置

安装后会自动生成默认配置文件：

```bash
~/.xbcode/settings.json
```

最小示例：

```json
{
  "providers": {
    "openai": {
      "models": [
        { "id": "gpt-4.1", "name": "GPT-4.1" },
        { "id": "gpt-4.1-mini", "name": "GPT-4.1 Mini" },
        { "id": "o3-mini", "name": "o3 Mini" }
      ],
      "apiKey": "YOUR_OPENAI_API_KEY",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses"
    },
    "deepseek": {
      "models": [
        { "id": "deepseek-chat", "name": "DeepSeek Chat", "description": "DeepSeek V3 chat model" }
      ],
      "apiKey": "sk-xxxxx",
      "baseURL": "https://api.deepseek.com/v1",
      "apiMode": "chat-completions"
    },
    "longcat": {
      "models": [
        { "id": "LongCat-Flash-Chat", "name": "LongCat Flash Chat", "description": "High-performance general-purpose dialogue model" },
        { "id": "LongCat-Flash-Omni-2603", "name": "LongCat Flash Omni", "description": "Multimodal model" },
        { "id": "LongCat-Flash-Thinking", "name": "LongCat Flash Thinking", "description": "LongCat thinking model" }
      ],
      "apiKey": "ak_xxxxxxx", // 去申请美团的龙猫模型，每天几百万的免费额度，足够测试开发了
      "baseURL": "https://api.longcat.chat/openai",
      "apiMode": "chat-completions"
    },
    "aliyun": {
      "models": ["qwen-plus", "qwen-turbo", "qwen-max"],
      "apiKey": "sk-xxx", // 阿里云百炼 API Key: https://dashscope.console.aliyun.com/
      "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1"
    },
    "volcengine": {
      "models": [
        { "id": "doubao-seed-2.0-code", "name": "Doubao Seed 2.0 Code" },
        { "id": "doubao-seed-2.0-pro", "name": "Doubao Seed 2.0 Pro" },
        { "id": "doubao-seed-2.0-lite", "name": "Doubao Seed 2.0 Lite" },
        { "id": "doubao-seed-code", "name": "Doubao Seed Code" },
        { "id": "minimax-m2.7", "name": "MiniMax M2.7" },
        { "id": "minimax-m3", "name": "MiniMax M3" },
        { "id": "glm-5.1", "name": "GLM 5.1" },
        { "id": "glm-5.2", "name": "GLM 5.2" },
        { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash" },
        { "id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro" },
        { "id": "kimi-k2.6", "name": "Kimi K2.6" }
      ],
      "apiKey": "YOUR_ARK_API_KEY",
      "baseURL": "https://ark.cn-beijing.volces.com/api/coding/v3",
      "apiMode": "chat-completions"
    }
  },
  "defaultProvider": "volcengine",
  "defaultModel": "doubao-seed-2.0-code",
  "showThinking": false,
  "mcp": {
    "servers": []
  }
}
```

### 启动

```bash
xbcode
```

本地开发：

```bash
npm run dev
```

构建并运行编译结果：

```bash
npm run build
npm start
```

### 第一次输入

启动后可以直接输入：

```text
读取当前项目结构，并解释 agent loop 是怎么工作的。
```

如果环境变量里没有预先指定 `MODEL_ID`，并且 `~/.xbcode/settings.json` 里也没有可用的 `defaultModel`，CLI 会引导你选择 provider 和 model。

当前安装后生成的默认配置会优先使用火山方舟 Ark，默认模型为 `doubao-seed-2.0-code`。

### 网络搜索

内置 `web_search` 工具使用 Brave Search API。需要在项目根目录 `.env` 或当前 shell 中配置：

```bash
BRAVE_SEARCH_API_KEY=你的 Brave Search API Key
```

模型需要查找最新信息时会先调用 `web_search` 获取候选结果，再用 `web_fetch` 读取选中的页面内容。

## 使用说明

### 常用命令

项目脚本：

```bash
npm run dev
npm run build
npm run test
npm start
```

全局安装后的启动命令：

```bash
xbcode
```

### Slash Commands

当前内置命令包括：

- `/help`
- `/status`
- `/goal [objective]`
- `/goal pause`
- `/goal resume`
- `/goal budget <tokens>`
- `/goal clear`
- `/login`
- `/logout`
- `/mcp`
- `/mcp refresh`
- `/team`
- `/inbox`
- `/provider`
- `/model`
- `/compact`
- `/new`
- `/exit`

如果 skill 提供了 prompt command，也会以 slash command 的形式暴露出来。

`/goal <objective>` 会创建一个随 session 持久化的目标。目标保持 `active` 时，宿主会自动开启续轮，直到模型标记完成或阻塞、用户暂停、运行错误触发暂停，或者 token 预算耗尽。`/resume` 恢复会话时也会恢复 goal 状态和用量。

### Provider 和模型配置

配置文件位置：

```bash
~/.xbcode/settings.json
```

支持配置多个 provider，每个 provider 可以包含：

- `models`
- `apiKey`
- `baseURL`
- `apiMode`
- `auth`

其中：

- `apiMode = responses`
  更适合 OpenAI 原生接口
- `apiMode = chat-completions`
  更适合兼容 Chat Completions 的第三方服务
- `auth = { "type": "oauth" }`
  目前仅用于 OpenAI，可选开启 ChatGPT OAuth 登录

OpenAI OAuth 配置示例：

```json
{
  "providers": {
    "openai": {
      "models": ["gpt-5.4", "gpt-5.4-mini"],
      "apiKey": "OPTIONAL_FALLBACK_KEY",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses",
      "auth": {
        "type": "oauth"
      }
    }
  }
}
```

如果不显式指定，程序也会根据 `baseURL` 做一部分自动判断，例如 DeepSeek、阿里云百炼兼容地址，以及火山方舟 Ark 兼容地址，都会默认切到 `chat-completions`。

对于火山方舟 Ark，请在 provider 里填写你的 Ark API Key，`baseURL` 使用 `https://ark.cn-beijing.volces.com/api/coding/v3`，`models` 则填写你可用的模型 ID。当前可直接配置的示例包括：`doubao-seed-2.0-code`、`doubao-seed-2.0-pro`、`doubao-seed-2.0-lite`、`doubao-seed-code`、`minimax-m2.7`、`minimax-m3`、`glm-5.1`、`deepseek-v4-flash`、`deepseek-v4-pro`、`kimi-k2.6`。

如果启用了 OpenAI OAuth：

- 静态 provider 配置仍然放在 `~/.xbcode/settings.json`
- 动态 OAuth 凭据会单独写入 `~/.xbcode/credentials.json`
- 运行时优先使用有效的 OAuth `access_token`
- 如果刷新失败，并且配置里还有 `apiKey`，则自动回退到 `apiKey`

OAuth 命令：

```bash
/login openai
/logout openai
```

如果 `/login` 不带参数，就默认登录当前 provider。当前版本会在终端打印 OpenAI 授权 URL，然后等待本地 localhost 回调完成登录。

### 工作区行为

`xbcode` 以当前工作目录作为默认基准，但文件工具不做路径沙箱限制：

- 文件工具接受相对路径、`..` 和绝对路径
- 相对路径基于 `process.cwd()` 解析
- shell 命令在当前工作目录执行
- 本地技能从 `<workdir>/skills` 加载
- 团队状态保存在 `<workdir>/.team`
- 任务保存在 `<workdir>/.tasks`

如果项目根目录存在 `AGENTS.md`，其内容会被注入 system prompt，用来约束 agent 行为。

### 内置工具

主 agent 可以访问：

- `bash`
- `read_file`
- `write_file`
- `edit_file`
- `task_create`
- `task_update`
- `task_list`
- `task_get`
- `list_mcp_resources`
- `read_mcp_resource`
- `mcp_call`
- `load_skill`
- `task`
- `message_send`
- `teammate_spawn`
- `teammate_list`
- `teammate_shutdown`
- `lead_inbox`

teammate 只能访问受限工具集：

- 基础工具
- `message_send`

这是刻意的权限收缩，用来避免无限递归派生和失控协作。

### 任务系统

任务是持久化存储的，每个任务对应一个 JSON 文件：

```bash
.tasks/task_<id>.json
```

任务字段包括：

- `id`
- `subject`
- `description`
- `status`
- `blockedBy`
- `blocks`

状态包括：

- `pending`
- `in_progress`
- `completed`

当任务被标记为 `completed` 时，依赖它的任务会自动解除阻塞。

### 技能系统

技能加载顺序如下：

- 全局技能目录（优先）：`~/.xbcode/skills`
- 全局技能目录（兼容 Claude）：`~/.claude/skills`
- 仓库本地技能目录：`<workdir>/skills`

规则是：

- `~/.xbcode/skills` 先加载
- `~/.claude/skills` 随后加载以保持兼容
- 本地技能最后加载，并可以覆盖同名全局技能

每个技能都由一个 `SKILL.md` 描述，支持 frontmatter。加载后可用于：

- system prompt 中的技能描述注入
- 生成 slash command
- 通过 `load_skill` 读取技能内容

### MCP 集成

MCP 配置写在：

```bash
~/.xbcode/settings.json
```

当前支持两种 transport：

- `stdio`
- `streamable-http`

当前实现中：

- MCP server 由共享运行时统一管理
- MCP tool 会被动态暴露为普通 function tool
- MCP resource 可通过 `list_mcp_resources` 发现
- MCP resource 内容可通过 `read_mcp_resource` 读取
- MCP prompt 通过 `mcp_call` 获取

相关文档：

- [docs/mcp-overview.md](./docs/mcp-overview.md)
- [docs/mcp-implementation.md](./docs/mcp-implementation.md)
- [docs/mcp-config.md](./docs/mcp-config.md)

### Team 模式

除了单次 `task` 子代理之外，`xbcode` 还支持常驻 teammate：

- `lead` 是和用户直接交互的主代理
- teammate 是具名、可持续存在的后台协作代理
- 协作通过 inbox 文件完成，而不是共享同一个上下文

团队状态保存在：

```bash
.team/
  config.json
  inbox/
    lead.jsonl
    <teammate>.jsonl
```

常用团队工具：

- `teammate_spawn`
- `teammate_list`
- `teammate_shutdown`
- `message_send`
- `lead_inbox`

这个设计让不同 agent 各自维护独立上下文，同时还能进行异步协作。

## 开发说明

### 目录结构

```text
code-agent/
  src/
    index.tsx              CLI UI 和输入循环
    agent.ts               核心 agent loop
    tools.ts               工具定义与 handler
    config.ts              配置读取和 provider 解析
    prompt.ts              system prompt 拼装
    compact.ts             上下文压缩
    task-manager.ts        持久化任务系统
    message-bus.ts         inbox 消息总线
    teammate-manager.ts    teammate 生命周期管理
    mcp/                   MCP 相关实现
    skills/                技能解析与渲染
  test/                    测试
  docs/                    设计与实现说明
  skills/                  示例本地技能
  scripts/postinstall.mjs  默认配置生成
```

### 核心模块职责

#### `src/index.tsx`

负责：

- 终端 UI 渲染
- 用户输入处理
- provider/model 选择
- slash command 分发
- 流式输出桥接

#### `src/agent.ts`

负责：

- 主执行回合调度
- 工具运行时准备
- Responses API 循环
- Chat Completions 循环
- 中断恢复
- 上下文压缩触发
- teammate runtime 执行

#### `src/tools.ts`

负责：

- 工具 schema 定义
- 权限范围控制
- 文件与 shell handler
- 任务和团队相关工具
- 技能接入
- MCP 接入

#### `src/config.ts`

负责：

- 读取 `~/.xbcode/settings.json`
- 规范化 provider 配置
- 模型选择
- MCP server 配置解析和校验

#### `src/prompt.ts`

负责 system prompt 的组装，输入包括：

- 当前工作目录
- 已加载技能描述
- MCP 指令
- 项目 `AGENTS.md`

#### `src/compact.ts`

负责两层上下文控制：

- `microCompact`
  缩短旧工具输出
- `autoCompact`
  对历史进行摘要压缩

在 `responses` 模式下，当前实现更接近“定期重置上下文链”，而不是保留摘要的连续压缩。

### 两种 API 模式

#### Responses API 模式

适合：

- OpenAI 原生接口
- 使用 `previous_response_id` 串联上下文

特点：

- 服务端维持上下文链
- 周期性重置链路，控制上下文增长

#### Chat Completions 模式

适合：

- 第三方兼容接口
- 需要本地维护消息历史的场景

特点：

- 本地维护 `chatHistory`
- 根据 token 估算结果触发压缩

### `task` 和 teammate 的区别

项目中有两种委派方式：

- `task`
  一次性、隔离上下文的子代理
- teammate
  持久存在、带身份和 inbox 的协作代理

当前 `task` 已支持最小化的 `subagent_type`：

- `general-purpose`
  默认子代理，适合实现、修改和一般性分包
- `explore`
  只读探索子代理，适合搜索代码、阅读实现、整理结论，不允许写文件

简单理解：

- 想做一次性分包，用 `task`
- 想持续协作，用 teammate

### 测试

运行测试：

```bash
npm test
```

当前测试覆盖了：

- 输入提交去重
- prompt 构建
- 技能加载与渲染
- 一些辅助函数行为

### 设计取舍

当前实现有一些明确的工程取舍：

- 文件访问不限制在当前工作区
- 主 agent 的写入类文件工具仍需要工具审批
- shell 命令有超时
- 一部分极危险命令会被直接拦截
- 工具输出会截断，防止撑爆上下文
- teammate 权限弱于 lead

这不是一个强安全沙箱，而是一个偏实用的本地 agent 约束层。

### 当前限制

当前还没有实现或仍然较弱的部分包括：

- 没有 worktree 级别隔离
- 没有通用长期调度器
- shell 危险命令过滤仍然比较基础
- Responses API 模式下的 compact 不是完整摘要链式压缩
- teammate 能力面被刻意限制

## 补充文档

更多实现说明可参考：

- [docs/TUTORIAL.md](./docs/TUTORIAL.md)
- [docs/task-dag.md](./docs/task-dag.md)
- [docs/context-compaction.md](./docs/context-compaction.md)
- [docs/mcp-plan.md](./docs/mcp-plan.md)
- [docs/mcp-overview.md](./docs/mcp-overview.md)
- [docs/mcp-implementation.md](./docs/mcp-implementation.md)
- [docs/mcp-config.md](./docs/mcp-config.md)
- [docs/agent-teams.md](./docs/agent-teams.md)
