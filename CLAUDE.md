# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript CLI agent (similar to Claude Code) built with OpenAI SDK + Ink (React for CLI). It implements an agent loop with tool use, streaming output, and a terminal UI.

## Commands

```bash
npm run dev      # Run in development (tsx, no compile)
npm run build    # Compile TypeScript to dist/
npm start        # Run compiled output
```

## Architecture

Multi-file architecture: `src/index.tsx` (UI), `src/agent.ts` (agent loop), `src/tools.ts` (tool definitions & handlers), `src/types.ts`, `src/todo.ts`.

**Dual API mode:** Supports both OpenAI Responses API (default) and Chat Completions API (for DeepSeek-compatible endpoints). Auto-detected via `OPENAI_BASE_URL` or set explicitly with `OPENAI_API_MODE`.

**Agent loop:** `agentLoop()` (Responses API) and `agentLoopWithChatCompletions()` (Chat Completions) implement the core think-act cycle. Both loop until LLM returns no tool calls.

**Tools:** 5 built-in tools — `bash`, `read_file`, `write_file`, `edit_file`, `task`. The `task` tool dispatches work to an independent sub-agent with a clean context (no parent history). Sub-agents have base tools only (no recursive `task`). Max 30 rounds per sub-agent. All tools return strings (errors included). Tool schema uses JSON Schema format with `additionalProperties: false`.

**UI layer:** React components rendered via Ink. `UiBridge` interface connects agent logic to UI updates (streaming deltas, tool call display).

**State:** `AgentState` holds `previousResponseId` (Responses API chain) or `chatHistory` (Chat Completions message array).

## Environment Variables

Configure in `.env` at project root:

- `OPENAI_API_KEY` — required
- `MODEL_ID` — default `gpt-4.1`
- `OPENAI_BASE_URL` — optional, for compatible endpoints
- `OPENAI_API_MODE` — `responses` or `chat-completions` (auto-detected)
- `SHOW_THINKING=1` — display model reasoning

## Key Conventions

- JSX runtime: `react-jsx` (not classic transform)
- Module system: ESM (`"type": "module"` in package.json, `NodeNext` in tsconfig)
- File paths in tool handlers are sandboxed to `process.cwd()` via `safePath()`
- Tool outputs are truncated to 50K characters
- Bash commands have a 120s timeout and a dangerous-command blocklist
