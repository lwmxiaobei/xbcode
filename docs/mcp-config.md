# MCP 配置说明

把 MCP 配置想成“给总机录入联系人”：

- 每个 server 都要有唯一名字
- 每个 server 都要说明怎么连接
- 连接方式目前只支持两种：`stdio` 和 `streamable-http`

如果名字、连接方式或关键字段不对，运行时会跳过该 server，并在配置告警里提示原因。

## 配置文件位置

当前项目从下面这个文件读取 MCP 配置：

- `~/.xbcode/settings.json`

MCP 配置挂在根对象的 `mcp.servers` 下。

## 可直接复制的完整 settings.json 示例

如果你想要一份“复制后改几个值就能用”的完整模板，可以直接从下面开始：

```json
{
  "providers": {
    "openai": {
      "models": [
        "gpt-4.1",
        "gpt-4o",
        "gpt-4o-mini"
      ],
      "apiKey": "YOUR_OPENAI_API_KEY",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses"
    },
    "deepseek": {
      "models": [
        "deepseek-chat"
      ],
      "apiKey": "YOUR_DEEPSEEK_API_KEY",
      "baseURL": "https://api.deepseek.com/v1",
      "apiMode": "chat-completions"
    }
  },
  "defaultProvider": "openai",
  "showThinking": false,
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "enabled": true,
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "."
        ],
        "cwd": "/Users/linweimin/codes/agent-learn/claude-code-mini/code-agent",
        "env": {
          "NODE_ENV": "production"
        },
        "timeoutMs": 30000
      },
      {
        "name": "remote-docs",
        "enabled": false,
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": {
          "Authorization": "Bearer YOUR_TOKEN"
        },
        "timeoutMs": 30000
      }
    ]
  }
}
```

你通常只需要改这几项：

- `YOUR_OPENAI_API_KEY`
- `YOUR_DEEPSEEK_API_KEY`
- `cwd`
- `url`
- `Authorization`
- 按需把某些 server 的 `enabled` 改成 `true` 或 `false`

### 这份模板适合谁

- 想快速起一个可工作的默认配置
- 同时保留 OpenAI 和 DeepSeek 两套 provider
- 先启用本地 `filesystem` server，再按需开启远端 MCP 服务

### 使用前注意

- `cwd` 最好改成你自己的项目路径
- 如果本机没有安装对应 MCP server，`stdio` server 会连接失败
- `remote-docs` 默认是 `enabled: false`，避免你还没配 URL 和 Token 就启动报错

## 最小结构

```json
{
  "providers": {
    "openai": {
      "models": ["gpt-4.1"],
      "apiKey": "your_api_key",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses"
    }
  },
  "defaultProvider": "openai",
  "mcp": {
    "servers": []
  }
}
```

即使你暂时不用 MCP，也建议保留：

```json
"mcp": {
  "servers": []
}
```

这样结构更清晰，也和当前默认值一致。

## 支持的连接方式

当前实现支持：

- `stdio`
- `streamable-http`

当前不支持：

- 其它自定义 transport 类型

## 一、stdio server

`stdio` 适合本地进程型 MCP server，比如通过 `npx`、`node`、本地二进制直接启动的服务。

### 示例

```json
{
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "enabled": true,
        "transport": "stdio",
        "command": "npx",
        "args": [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          "."
        ],
        "cwd": "/Users/linweimin/codes/agent-learn/claude-code-mini/code-agent",
        "env": {
          "NODE_ENV": "production"
        },
        "timeoutMs": 30000
      }
    ]
  }
}
```

### 字段说明

- `name`
  - server 的唯一名字
  - 后续 `mcp_call` 会直接用它
- `enabled`
  - 是否启用
  - 不填时默认 `true`
- `transport`
  - 固定写 `stdio`
- `command`
  - 启动命令，必填
- `args`
  - 命令参数，选填
- `cwd`
  - 子进程工作目录，选填
- `env`
  - 传给子进程的环境变量，选填
- `timeoutMs`
  - 请求超时时间，单位毫秒
  - 不合法时会回退到 `30000`

### 适合的场景

- 本地开发调试
- 依赖本地文件系统、Git、数据库 CLI 等能力
- 不希望暴露远程 HTTP 服务

## 二、streamable-http server

`streamable-http` 适合远端部署的 MCP server，通过 URL 访问。

### 示例

```json
{
  "mcp": {
    "servers": [
      {
        "name": "remote-docs",
        "enabled": true,
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": {
          "Authorization": "Bearer your_token"
        },
        "timeoutMs": 30000
      }
    ]
  }
}
```

### 字段说明

- `name`
  - server 的唯一名字
- `enabled`
  - 是否启用
- `transport`
  - 固定写 `streamable-http`
- `url`
  - 服务地址，必填
- `headers`
  - 请求头，选填
- `timeoutMs`
  - 请求超时时间，选填

### 适合的场景

- 统一接入公司内部 MCP 网关
- 团队共享同一个远端能力服务
- 需要通过认证头访问的服务

## 可以混合配置多个 server

你可以同时配置多个本地和远端 server：

```json
{
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "enabled": true,
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        "timeoutMs": 30000
      },
      {
        "name": "remote-docs",
        "enabled": true,
        "transport": "streamable-http",
        "url": "https://example.com/mcp",
        "headers": {
          "Authorization": "Bearer your_token"
        },
        "timeoutMs": 30000
      }
    ]
  }
}
```

运行时会：

- 按配置创建多个连接对象
- 分别初始化每个启用的 server
- 分别缓存 tools/resources/prompts
- 某一个 server 失败时，不阻断其它 server

## 字段校验规则

当前配置归一化逻辑在 [src/config.ts](src/config.ts) 中，主要规则如下：

- `servers` 必须是数组
- 每个 server 必须是对象
- `name` 必须非空，且不能重复
- `transport` 只能是：
  - `stdio`
  - `streamable-http`
- `stdio` 必须提供 `command`
- `streamable-http` 必须提供 `url`
- `timeoutMs` 必须是正数，否则回退为 `30000`
- `args` 必须是数组，否则会被忽略并记录告警
- `env` / `headers` 必须是对象，否则会被忽略并记录告警

## 常见配置错误

### 1. server 名字重复

错误示例：

```json
{
  "mcp": {
    "servers": [
      { "name": "docs", "transport": "streamable-http", "url": "https://a.example.com/mcp" },
      { "name": "docs", "transport": "streamable-http", "url": "https://b.example.com/mcp" }
    ]
  }
}
```

结果：

- 后面的重复名字会被忽略
- 配置告警里会出现 duplicate name 提示

### 2. `stdio` 漏了 `command`

错误示例：

```json
{
  "name": "filesystem",
  "transport": "stdio"
}
```

结果：

- 该 server 不会被注册
- 会收到“missing command”告警

### 3. `streamable-http` 漏了 `url`

错误示例：

```json
{
  "name": "remote-docs",
  "transport": "streamable-http"
}
```

结果：

- 该 server 不会被注册
- 会收到“missing url”告警

### 4. `timeoutMs` 非法

错误示例：

```json
{
  "name": "docs",
  "transport": "streamable-http",
  "url": "https://example.com/mcp",
  "timeoutMs": -1
}
```

结果：

- 不会直接报废这个 server
- 会自动回退到 `30000`

## `enabled` 的作用

`enabled` 用来控制 server 是否参与初始化。

例如：

```json
{
  "name": "remote-docs",
  "enabled": false,
  "transport": "streamable-http",
  "url": "https://example.com/mcp"
}
```

结果：

- 配置仍然保留
- 运行时状态会显示为 `disabled`
- 不会建立连接

这对临时关闭某个 server 很有用，不必删掉整段配置。

## 配好后怎么调用

配置完成后，模型和 agent 统一通过 `mcp_call` 使用 MCP。

调用时需要提供：

- `server`
- `kind`
- `name` 或 `uri`
- 可选 `arguments`

例如：

```json
{
  "server": "filesystem",
  "kind": "tool",
  "name": "read_file",
  "arguments": {
    "path": "README.md"
  }
}
```

注意：

- `server` 要用配置里的精确名字
- `tool` / `prompt` 名称要用缓存里的精确名字
- `resource` 要用精确 URI

不要猜名字。

## 快速自检

如果你想确认本地 MCP 配置是否真的连上，而不是只停留在“JSON 写对了”，可以在项目根目录运行：

```bash
npx tsx -e "(async function () { const mod = await import('./src/mcp/runtime.ts'); await mod.ensureMcpInitialized(); console.log(mod.mcpManager.formatStatusReport()); })().catch((error) => { console.error(error); process.exit(1); });"
```

这条命令会直接走当前项目的 MCP 运行时初始化流程，并打印状态报告。

如果本地 `filesystem` MCP 配置正常，你会看到类似结果：

```text
MCP servers: configured 1 | enabled 1 | connected 1 | degraded 0 | disconnected 0 | disabled 0
- filesystem [connected] stdio
```

如果状态是 `connected`，说明至少这几件事已经成立：

- `~/.xbcode/settings.json` 被正确读取了
- `mcp.servers` 被正确解析了
- `npx -y @modelcontextprotocol/server-filesystem .` 能正常启动
- 当前 agent 运行时已经成功拿到了该 server 的工具缓存

## 推荐的排查顺序

如果 MCP 看起来没生效，建议按这个顺序排查：

1. 检查 `~/.xbcode/settings.json` 是否是合法 JSON
2. 检查 `mcp.servers` 是否存在
3. 检查 `name` 是否重复
4. 检查 `transport` 是否写对
5. `stdio` 检查 `command`
6. `streamable-http` 检查 `url`
7. 检查 `enabled` 是否误设为 `false`
8. 再用 MCP 状态命令或运行时状态报告看具体错误

## 相关文档

- [docs/mcp-overview.md](docs/mcp-overview.md)
  - 了解当前代码结构和调用链
- [docs/mcp-plan.md](docs/mcp-plan.md)
  - 查看最初设计方案
