# TypeScript OpenAI Agent

A terminal-based AI coding agent built with TypeScript, React/Ink, and OpenAI's APIs. This agent can solve coding tasks, manage projects, collaborate with teammates, and extend functionality through a skills system.

## Features

- **AI-Powered Coding Assistant**: Interact with OpenAI models (GPT-4, GPT-3.5, etc.) to solve programming tasks
- **Multi-Agent Collaboration**: Spawn and manage persistent teammates for parallel task execution
- **Task Management**: Built-in task tracking with dependencies and status management
- **Skills System**: Extensible through skill files that provide specialized knowledge and capabilities
- **Message Bus**: Communication system for agent-to-agent messaging
- **Terminal UI**: Beautiful, interactive terminal interface built with Ink
- **API Compatibility**: Supports both OpenAI Responses API and Chat Completions API
- **Token Management**: Automatic conversation history compaction to stay within token limits
- **Configuration Management**: Provider and model profiles with centralized settings

## Quick Start

### Installation

```bash
npm install
```

### Environment Setup

Create a `.env` file in the project directory:

```bash
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://api.openai.com/v1  # or your custom endpoint
MODEL_ID=gpt-4-turbo-preview
```

### Run Development Mode

```bash
npm run dev
```

### Build and Run Production

```bash
npm run build
npm start
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | - | Your OpenAI API key |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | API endpoint URL |
| `MODEL_ID` | No | `gpt-4-turbo-preview` | Model identifier |
| `OPENAI_API_MODE` | No | `responses` | API mode: `responses` or `chat-completions` |
| `SHOW_THINKING` | No | `false` | Show AI thinking process (set to `1` to enable) |
| `USE_DOCKED_PROMPT` | No | `false` | Use docked prompt interface (set to `1` to enable) |

### Settings File

The agent uses a centralized settings file at `~/.codemini/settings.json`:

```json
{
  "providers": {
    "openai": {
      "models": ["gpt-4-turbo-preview", "gpt-4", "gpt-3.5-turbo"],
      "apiKey": "your_api_key",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses"
    },
    "deepseek": {
      "models": ["deepseek-chat"],
      "apiKey": "your_deepseek_key",
      "baseURL": "https://api.deepseek.com/v1",
      "apiMode": "chat-completions"
    }
  },
  "defaultProvider": "openai",
  "showThinking": false
}
```

### Supported Models

The agent supports various models through provider configurations:
- OpenAI: GPT-4, GPT-3.5 Turbo, GPT-4o, etc.
- DeepSeek: DeepSeek Chat, DeepSeek Coder
- Any OpenAI-compatible API endpoint

## Usage

### Basic Interaction

Once running, the agent presents a terminal interface:

```
You are a coding agent at /path/to/workspace. Use tools to solve tasks. Act, don't explain.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
 - skill1: Description of skill1
 - skill2: Description of skill2

[user] >
```

Type your query or task and press Enter. The agent will use available tools and skills to solve it.

### Available Commands

| Command | Description |
|---------|-------------|
| `/help` or `help` | Show help information |
| `/status` or `status` | Show agent status and configuration |
| `/team` or `team` | Show teammate status |
| `/inbox` or `inbox` | Drain the lead inbox |
| `/provider [name]` or `provider [name]` | List or switch providers |
| `/model [name]` or `model [name]` | List or switch models |
| `/compact` or `compact` | Compact conversation history |
| `/new` or `new` | Start a new conversation |
| `/exit` or `exit` | Exit the application |

Press `Esc` while a turn is running to stop the current loop without clearing the session context.

### Task Management

The agent includes a task management system:

```bash
# List all tasks
task_list

# Create a new task
task_create "Task subject" "Optional description"

# Update task status
task_update 1 --status completed

# View task details
task_get 1
```

### Teammate Collaboration

Create and manage persistent teammates:

```bash
# Spawn a new teammate
teammate_spawn "alice" "Frontend Developer" "Build the React components"

# List active teammates
teammate_list

# Send message to teammate
message_send "alice" "Please review the PR"

# Shutdown teammates
teammate_shutdown "alice"
teammate_shutdown  # Shutdown all teammates
```

## Skills System

Skills are modular knowledge units that extend the agent's capabilities. Skills are loaded from:

1. Global skills: `~/.claude/skills/`
2. Local skills: `./skills/` (overrides global)

### Skill Structure

Each skill is a directory containing a `SKILL.md` file with frontmatter metadata:

```markdown
---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces
tags: design, frontend, ui
---

This skill provides guidance for creating beautiful, responsive web interfaces...

## When to Use

Use this skill when the user asks to build web components, pages, or applications...
```

### Available Skills

The agent comes with many built-in skills:

- **frontend-design**: Create production-grade frontend interfaces
- **ai-sdk**: Build AI-powered features with Vercel AI SDK
- **code-review**: Review code for quality and best practices
- **supabase-postgres-best-practices**: Postgres optimization and best practices
- **expo-tailwind-setup**: Tailwind CSS setup for Expo apps
- **vercel-react-best-practices**: React and Next.js performance guidelines
- **opencli**: Interact with websites and external tools via command line
- **generate-image**: Generate and edit images with AI
- **post-to-x**: Post content to X (Twitter)
- **pdf**: Process and extract content from PDF files
- ...and many more

## Development

### Project Structure

```
ts-openai-agent/
├── src/
│   ├── index.tsx           # Main application entry point
│   ├── agent.ts            # Core AI agent logic
│   ├── tools.ts            # Tool implementations
│   ├── skills.ts           # Skill loader and management
│   ├── task-manager.ts     # Task management system
│   ├── teammate-manager.ts # Teammate management
│   ├── message-bus.ts      # Inter-agent messaging
│   ├── compact.ts          # Token management and conversation compaction
│   ├── config.ts           # Configuration management
│   ├── types.ts           # TypeScript type definitions
│   └── team-types.ts      # Team-related type definitions
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

### Building

```bash
# Install dependencies
npm install

# Development mode with hot reload
npm run dev

# Build for production
npm run build

# Run tests
npm test
```

### Adding New Skills

1. Create a skill directory in `./skills/` or `~/.claude/skills/`:

```bash
mkdir -p skills/my-skill
```

2. Create a `SKILL.md` file with frontmatter and content:

```markdown
---
name: my-skill
description: Description of your skill
tags: tag1, tag2
---

# My Skill

Detailed skill content...

## When to Use

Use when...
```

3. The skill will be automatically loaded on next agent start.

## API Reference

### Tool Functions

The agent provides these core tools:

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands |
| `read_file` | Read file contents |
| `write_file` | Write content to file |
| `edit_file` | Replace text in file |
| `task_create` | Create a new task |
| `task_update` | Update task status |
| `task_list` | List all tasks |
| `task_get` | Get task details |
| `load_skill` | Load specialized knowledge |
| `message_send` | Send message to teammate |
| `teammate_spawn` | Create persistent teammate |
| `teammate_list` | List active teammates |
| `teammate_shutdown` | Shutdown teammates |

### Agent Configuration

Key configuration types:

```typescript
interface AgentConfig {
  client: OpenAI;
  model: string;
  system: string;
  showThinking: boolean;
  apiMode: 'responses' | 'chat-completions';
}

interface Settings {
  providers: Record<string, ModelProfile>;
  defaultProvider?: string;
  showThinking?: boolean;
}
```

## Troubleshooting

### Common Issues

**"No API key configured"**
- Ensure `OPENAI_API_KEY` is set in `.env` or settings file
- Check that the `.env` file is in the correct directory

**"Model not found"**
- Verify the model ID in configuration
- Check provider settings and base URL

**"Token limit exceeded"**
- The agent automatically compacts conversation history
- Consider reducing the complexity of individual requests

**"Skill not loading"**
- Check skill directory structure
- Verify `SKILL.md` file exists and has proper frontmatter
- Ensure skill name doesn't conflict with existing skills

### Debug Mode

Set environment variables for debugging:

```bash
DEBUG=1 npm run dev
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes and add tests
4. Submit a pull request

### Development Guidelines

- Use TypeScript for all new code
- Follow existing code style and patterns
- Add tests for new functionality
- Update documentation for changes
- Keep skills focused and well-documented

## License

MIT License
