# TypeScript OpenAI Version

This directory contains a TypeScript translation of the Python CLI agent from the workspace root.

## Environment

Create a `.env` file in this directory:

```bash
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://your-base-url
MODEL_ID=gpt-4.1
```

The CLI reads `.env` from the `ts-openai-agent` directory automatically.

Supported variables:

- `OPENAI_API_KEY`
- `MODEL_ID`

Optional:

- `OPENAI_BASE_URL`
- `OPENAI_API_MODE` (`responses` or `chat-completions`)
- `SHOW_THINKING=1`
- `USE_DOCKED_PROMPT=1`

## Terminal UX

The CLI now uses a more code-agent style terminal flow inspired by tools like Claude Code and Codex:

- session banner with workspace, model, API mode, and shortcut commands
- boxed input prompt in TTY mode
- separated `user`, `assistant`, and `tool` output sections
- built-in slash commands for common session actions

Supported slash commands:

- `/help`
- `/status`
- `/clear`
- `/exit`

The same commands also work without the leading slash:

- `help`
- `status`
- `clear`
- `exit`

Notes:

- Native OpenAI uses the Responses API by default.
- DeepSeek-style OpenAI-compatible endpoints are auto-detected and use Chat Completions instead, because `/responses` is not available there.

## Run

```bash
npm install
npm run dev
```

Build and run compiled output:

```bash
npm run build
npm start
```