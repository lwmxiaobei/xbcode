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

Multi-file architecture: `src/index.tsx` (UI), `src/agent.ts` (agent loop), `src/agent/` (loop internals: streaming, tool calls, usage, messages), `src/tools.ts` (tool definitions & handler routing), `src/tools/` (file tool implementations), `src/types.ts`.

**Dual API mode:** Supports both OpenAI Responses API (default) and Chat Completions API (for DeepSeek-compatible endpoints). Auto-detected via `OPENAI_BASE_URL` or set explicitly with `OPENAI_API_MODE`.

**Agent loop:** `agentLoop()` (Responses API) and `agentLoopWithChatCompletions()` (Chat Completions) implement the core think-act cycle. Both loop until LLM returns no tool calls.

**Tools:** Defined in `src/tools.ts` (schemas + handler routing). Beyond the file and shell tools there are `glob`/`grep`, MCP access, skills, web fetch/search, the task board, goals, teammates, and `subagent` (dispatches work to an independent sub-agent with a clean context; sub-agents get base tools only, no recursive dispatch). Tool schemas use JSON Schema with `additionalProperties: false`.

A handler returns either a plain string or `{ output, details }` — `output` is what the model sees, `details` carries structured data for the UI only (currently `edit_file`'s diff and unified patch). `executeToolCall` normalizes both shapes.

**File tools:** implemented under `src/tools/`, not in `tools.ts`:

- `file-tools.ts` — `read_file` / `write_file` / `edit_file`, plus injectable `operations` so the tools can be pointed at a remote filesystem.
- `edit-diff.ts` — matching and diff generation. `edit_file` takes an `edits[]` array applied atomically; every `old_text` is matched against the *original* file and must hit exactly one non-overlapping place, otherwise the call fails and nothing is written. Exact match is tried first, then a fuzzy pass (NFKC, per-line trailing whitespace, curly quotes, Unicode dashes/spaces); a fuzzy hit only rewrites the lines it touches so untouched bytes survive. BOM and CRLF are preserved.
- `file-truncate.ts` — `read_file` caps output at 2000 lines or 50KB, whichever hits first, and tells the model the exact `offset` to pass to continue.
- `file-mutation-queue.ts` — serializes writes to the same file (keyed by realpath); different files still run in parallel.
- `image.ts` — header-sniffed image support for `read_file`. Since neither API accepts images in a tool result, `read_file` queues the image on `RunControl.pendingImages` and the agent loop sends it as a follow-up user message.

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
- File paths in tool handlers are not sandboxed. Relative paths resolve from `process.cwd()`, while `..` and absolute paths are allowed. `~` is expanded, and a path that does not resolve is retried against a few macOS filename variants (NFD, narrow no-break space before AM/PM, curly apostrophe).
- Two different truncation strategies, on purpose: `bash`/`grep`/`web_fetch` use a 12K-token *middle* truncation (`src/truncate.ts`) so head and tail both survive; `read_file` uses head truncation with line/byte limits (`src/tools/file-truncate.ts`) so paging with `offset` stays coherent.
- Bash commands have a 120s timeout and a dangerous-command blocklist
