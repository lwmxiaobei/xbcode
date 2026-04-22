[English](./README.md) | [简体中文](./README.zh-CN.md)

# xbcode

`xbcode` is a TypeScript-based CLI coding agent built with OpenAI SDK and Ink. It runs in the terminal, streams model output, executes tools inside the current workspace, supports persistent tasks, skills, MCP integration, and lightweight multi-agent teamwork.

The project is positioned as a compact, hackable alternative to heavier coding agents: small enough to read end-to-end, but already opinionated enough to be useful in day-to-day coding workflows.

## Features

- Terminal-first interactive coding agent UI built with Ink and React
- Dual API support: OpenAI Responses API and Chat Completions API
- Workspace-scoped file and shell tools
- Persistent task board stored on disk in `.tasks/`
- Skills system with global and repo-local skill loading
- MCP integration with dynamic MCP tool exposure plus prompt/resource access
- Persistent teammates with inbox-based asynchronous coordination
- Context compaction for long-running conversations
- ESM TypeScript codebase with a small, readable architecture

## Quick Start

### Install

```bash
npm install -g @lwmxiaobei/xbcode
```

Or run locally in this repo:

```bash
npm install
npm run dev
```

### First-run configuration

On install, `xbcode` creates a default config file at:

```bash
~/.xbcode/settings.json
```

Minimal example:

```json
{
  "providers": {
    "openai": {
      "models": ["gpt-4.1", "gpt-4.1-mini", "o3-mini"],
      "apiKey": "YOUR_OPENAI_API_KEY",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses"
    }
  },
  "defaultProvider": "openai",
  "showThinking": false,
  "mcp": {
    "servers": []
  }
}
```

### Start the CLI

```bash
xbcode
```

Local development:

```bash
npm run dev
```

Build and run compiled output:

```bash
npm run build
npm start
```

### First prompt

After launch, enter a request such as:

```text
Read the project structure and explain how the agent loop works.
```

If `MODEL_ID` is not preset in the environment, the CLI will guide you through interactive provider/model selection from `~/.xbcode/settings.json`.

## How It Works

At a high level, `xbcode` runs a standard think-act loop:

1. Build a system prompt from built-in rules, loaded skill descriptions, MCP instructions, and optional project `AGENTS.md`.
2. Send the current turn to the selected model.
3. Stream assistant output into the Ink UI.
4. Execute tool calls when the model asks for them.
5. Feed tool results back to the model.
6. Repeat until the model stops requesting tools.

The current implementation supports two backend styles:

- `responses`
  Uses OpenAI Responses API and chains turns via `previous_response_id`
- `chat-completions`
  Uses local chat history and supports compatible endpoints such as DeepSeek-style APIs

## User Guide

### Commands

Package scripts:

```bash
npm run dev
npm run build
npm run test
npm start
```

Published binary:

```bash
xbcode
```

### Slash commands

Built-in slash commands currently include:

- `/help`
- `/status`
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

Skill prompt-commands are also exposed as slash commands when available from loaded skills.

### Provider and model configuration

Providers are configured in `~/.xbcode/settings.json`:

```json
{
  "providers": {
    "openai": {
      "models": [
        "gpt-4.1",
        { "id": "gpt-4.1-mini", "name": "GPT-4.1 Mini", "description": "Fast general model" }
      ],
      "apiKey": "YOUR_KEY",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses",
      "auth": {
        "type": "oauth"
      }
    }
  },
  "defaultProvider": "openai",
  "showThinking": false
}
```

Key fields:

- `providers`
  Named provider profiles
- `models`
  A list of model IDs or richer model descriptors
- `defaultProvider`
  Used when no provider is explicitly selected
- `showThinking`
  Enables display of model reasoning deltas when supported
- `apiMode`
  Either `responses` or `chat-completions`
- `auth`
  Optional provider auth mode. Today only `{ "type": "oauth" }` is supported, and only for OpenAI.

API mode can be explicit, or derived automatically. For example, DeepSeek-compatible base URLs default to `chat-completions`.

When OpenAI OAuth is enabled:

- Static provider settings remain in `~/.xbcode/settings.json`
- Dynamic OAuth credentials are stored separately in `~/.xbcode/credentials.json`
- Runtime auth prefers a valid OAuth `access_token`
- If refresh fails, `xbcode` falls back to the provider `apiKey` when one is configured

OAuth commands:

```bash
/login openai
/logout openai
```

`/login` without an argument uses the current provider. In this first version, the CLI prints the OpenAI authorization URL in the terminal and waits for the localhost callback to complete.

### Workspace behavior

`xbcode` operates relative to the current working directory:

- File tools are sandboxed to `process.cwd()`
- Shell commands run with `cwd = process.cwd()`
- Local skills are loaded from `<workdir>/skills`
- Team state lives under `<workdir>/.team`
- Tasks are stored under `<workdir>/.tasks`

If the current project contains an `AGENTS.md`, its contents are injected into the system prompt and influence agent behavior.

### Built-in tools

The lead agent has access to:

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

Teammates get a reduced tool surface:

- Base tools
- `message_send`

This is a deliberate constraint to prevent uncontrolled recursive delegation.

### Tasks

The task system is persistent and file-backed. Each task is stored as a JSON file under:

```bash
.tasks/task_<id>.json
```

Task fields include:

- `id`
- `subject`
- `description`
- `status`
- `blockedBy`
- `blocks`

Supported statuses:

- `pending`
- `in_progress`
- `completed`

When a task is marked `completed`, dependent tasks are automatically unblocked.

### Skills

Skills provide reusable instructions and domain-specific guidance. They are loaded from two locations:

- Global: `~/.claude/skills`
- Local: `<workdir>/skills`

Loading order matters:

- Global skills are loaded first
- Local skills override global skills with the same `name`

Each skill is defined by a `SKILL.md` file with frontmatter. The loader exposes:

- skill descriptions for prompt construction
- prompt commands
- rendered skill content via `load_skill`

Two example local skills ship in this repo:

- `skills/pdf/SKILL.md`
- `skills/code-review/SKILL.md`

### MCP

MCP server configuration lives in:

```bash
~/.xbcode/settings.json
```

Supported transports:

- `stdio`
- `streamable-http`

Example:

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
        "cwd": "/path/to/project",
        "timeoutMs": 30000
      }
    ]
  }
}
```

Current MCP behavior:

- MCP servers are initialized through a shared runtime manager
- MCP tools are dynamically surfaced as normal function tools
- MCP resources can be discovered with `list_mcp_resources`
- Cached resources can be read with `read_mcp_resource`
- MCP prompts are retrieved through `mcp_call`

For deeper details, see:

- [docs/mcp-overview.md](./docs/mcp-overview.md)
- [docs/mcp-implementation.md](./docs/mcp-implementation.md)
- [docs/mcp-config.md](./docs/mcp-config.md)

### Team mode

`xbcode` supports persistent teammates instead of only one-shot sub-agents.

Conceptually:

- `lead` is the main CLI-facing agent
- teammates are long-lived worker agents with names and roles
- coordination happens through append-only inbox files

Team state is stored under:

```bash
.team/
  config.json
  inbox/
    lead.jsonl
    <teammate>.jsonl
```

Useful tools:

- `teammate_spawn`
- `teammate_list`
- `teammate_shutdown`
- `message_send`
- `lead_inbox`

This model supports asynchronous collaboration while keeping contexts isolated per agent.

For the design background, see [docs/agent-teams.md](./docs/agent-teams.md).

## Developer Guide

### Project layout

```text
code-agent/
  src/
    index.tsx              CLI UI and input loop
    agent.ts               core agent loop
    tools.ts               tool definitions and handlers
    config.ts              settings loading and provider resolution
    prompt.ts              system prompt construction
    compact.ts             context compaction logic
    task-manager.ts        persistent task storage
    message-bus.ts         inbox-based messaging
    teammate-manager.ts    persistent teammate lifecycle
    mcp/                   MCP runtime, manager, client, types
    skills/                skill parsing and rendering
  test/                    node:test test suite
  docs/                    design and implementation notes
  skills/                  example local skills
  scripts/postinstall.mjs  default config bootstrap
```

### Core modules

#### `src/index.tsx`

Responsible for:

- terminal UI rendering through Ink
- input handling
- provider/model selection
- slash command dispatch
- bridge from streaming agent events into the UI

#### `src/agent.ts`

Responsible for:

- main turn orchestration
- tool/runtime preparation
- Responses API loop
- Chat Completions loop
- interruption handling
- context compaction triggers
- teammate runtime behavior

#### `src/tools.ts`

Responsible for:

- tool schemas
- tool permission boundaries
- local file and shell handlers
- task and team operations
- skill loading bridge
- MCP entry points

#### `src/config.ts`

Responsible for:

- reading `~/.xbcode/settings.json`
- normalizing provider settings
- selecting models
- validating and normalizing MCP server configs

#### `src/prompt.ts`

Responsible for building the static system prompt from:

- workdir
- available skill descriptions
- MCP prompt instructions
- optional project-level `AGENTS.md`

#### `src/compact.ts`

Implements two levels of history control:

- `microCompact`
  Shrinks old tool outputs in local chat history
- `autoCompact`
  Summarizes history and replaces it with a compressed summary

Responses mode uses a different strategy: periodic reset of the `previous_response_id` chain.

### API modes

#### Responses API mode

Best fit for:

- OpenAI-native models
- simpler server-side context chaining

Behavior:

- chains turns through `previous_response_id`
- periodically resets the chain to cap growth
- does not maintain the same local history structure as chat mode

#### Chat Completions mode

Best fit for:

- compatible non-OpenAI endpoints
- providers that only expose chat-completions style APIs

Behavior:

- stores local message history
- compacts history when token estimates cross thresholds
- supports tool-loop behavior through standard tool calls

### Sub-agents vs teammates

There are two delegation models:

- `task`
  Creates a one-shot isolated sub-agent with a clean context and a bounded maximum round count
- teammates
  Persistent workers with identities, inboxes, statuses, and wake/sleep lifecycle

Use `task` for isolated execution. Use teammates for ongoing coordination.

### Testing

Run the test suite with:

```bash
npm test
```

Current tests cover areas such as:

- input submit deduplication
- prompt building
- skill loading and rendering
- utility behavior

The test runner uses native `node:test` with `tsx`.

### Publishing

The package is published as:

```text
@lwmxiaobei/xbcode
```

Important package details:

- binary name: `xbcode`
- module format: ESM
- build output: `dist/`
- `prepublishOnly` runs build plus tests

## Design Notes and Trade-offs

### Safety boundaries

The current implementation intentionally enforces several simple constraints:

- file access is restricted to the current workspace through `safePath()`
- shell commands have a timeout
- very dangerous shell snippets are blocked
- tool output is truncated to avoid blowing up context size
- teammate tool permissions are narrower than lead permissions

This is not a hardened sandbox. It is a pragmatic local-agent safety layer.

### Why the project stays small

The codebase favors:

- direct composition over deep abstractions
- file-backed persistence over databases
- explicit modules over framework-heavy orchestration
- readable control flow over maximum generality

That makes it easier to understand, modify, and compare against larger agent implementations.

### Current limitations

Notable limitations in the current implementation:

- no git worktree isolation for teammates or sub-agents
- no long-lived scheduler beyond teammate wake/sleep behavior
- dangerous command filtering is intentionally simple, not exhaustive
- Responses API compaction is a chain reset, not a summary-preserving merge
- teammate execution is intentionally capability-limited

## Documentation

Additional project notes live under `docs/`:

- [docs/TUTORIAL.md](./docs/TUTORIAL.md)
- [docs/task-dag.md](./docs/task-dag.md)
- [docs/context-compaction.md](./docs/context-compaction.md)
- [docs/mcp-plan.md](./docs/mcp-plan.md)
- [docs/mcp-overview.md](./docs/mcp-overview.md)
- [docs/mcp-implementation.md](./docs/mcp-implementation.md)
- [docs/mcp-config.md](./docs/mcp-config.md)
- [docs/agent-teams.md](./docs/agent-teams.md)

## Development

Install dependencies:

```bash
npm install
```

Run in development:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Build:

```bash
npm run build
```

## License

No license file is included in this repository snapshot. Add one before public redistribution if needed.
