import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

import { TaskManager } from "./task-manager.js";
import { SkillLoader } from "./skills.js";
import type { ToolArgs } from "./types.js";

const execAsync = promisify(exec);
const WORKDIR = process.cwd();
import os from "node:os";

const GLOBAL_SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");
const LOCAL_SKILLS_DIR = path.join(WORKDIR, "skills");

// Global skills loaded first, local skills override duplicates
export const skillLoader = new SkillLoader([GLOBAL_SKILLS_DIR, LOCAL_SKILLS_DIR]);

export const taskManager = new TaskManager(path.join(WORKDIR, ".tasks"));

function safePath(relativePath: string): string {
  const resolved = path.resolve(WORKDIR, relativePath);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${relativePath}`);
  }
  return resolved;
}

function isExecTimeout(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "killed" in error && Boolean((error as { killed?: boolean }).killed);
}

function toExecError(error: unknown): { stdout?: string; stderr?: string } {
  if (typeof error === "object" && error !== null) {
    return error as { stdout?: string; stderr?: string };
  }
  return {};
}

async function runBash(command: string): Promise<string> {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((snippet) => command.includes(snippet))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKDIR,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 10,
      shell: process.env.SHELL,
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

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export const BASE_TOOLS = [
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
        limit: { type: "integer" },
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
  {
    type: "function",
    name: "task_create",
    description: "Create a new task. Returns the created task as JSON.",
    parameters: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Short title of the task" },
        description: { type: "string", description: "Detailed description (optional)" },
      },
      required: ["subject"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_update",
    description:
      "Update a task's status or dependencies. When a task is marked completed, all tasks blocked by it are automatically unblocked.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the task to update" },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        blocked_by: {
          type: "array",
          items: { type: "integer" },
          description: "Task IDs that this task depends on (add to existing)",
        },
        blocks: {
          type: "array",
          items: { type: "integer" },
          description: "Task IDs that depend on this task (add to existing)",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_list",
    description: "List all tasks with their status and dependencies.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "task_get",
    description: "Get full details of a single task by ID.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "integer", description: "ID of the task" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "load_skill",
    description: "Load specialized knowledge by name. Use this to access domain-specific guidance before tackling unfamiliar topics.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name to load" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
] as const;

export const TASK_TOOL = {
  type: "function",
  name: "task",
  description:
    "Dispatch a subtask to an independent sub-agent with a clean context. The sub-agent has all base tools (bash, read_file, write_file, edit_file) but cannot spawn further sub-agents. Use this for isolated, well-defined tasks to keep the main conversation context clean. Returns only the sub-agent's final summary.",
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A clear, self-contained description of the task for the sub-agent to perform.",
      },
    },
    required: ["description"],
    additionalProperties: false,
  },
} as const;

export const TOOLS = [...BASE_TOOLS, TASK_TOOL] as const;

export const CHAT_TOOLS = TOOLS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

export const BASE_CHAT_TOOLS = BASE_TOOLS.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

export const TOOL_HANDLERS: Record<string, (args: ToolArgs) => Promise<string> | string> = {
  bash: ({ command }) => runBash(String(command)),
  read_file: ({ path: filePath, limit }) => runRead(String(filePath), toOptionalNumber(limit)),
  write_file: ({ path: filePath, content }) => runWrite(String(filePath), String(content)),
  edit_file: ({ path: filePath, old_text, new_text }) => runEdit(String(filePath), String(old_text), String(new_text)),
  task_create: ({ subject, description }) => taskManager.create(String(subject), description ? String(description) : undefined),
  task_update: ({ task_id, status, blocked_by, blocks }) =>
    taskManager.update(
      Number(task_id),
      status ? String(status) : undefined,
      blocked_by as number[] | undefined,
      blocks as number[] | undefined,
    ),
  task_list: () => taskManager.list(),
  task_get: ({ task_id }) => taskManager.get(Number(task_id)),
  load_skill: ({ name }) => skillLoader.getContent(String(name)),
};
