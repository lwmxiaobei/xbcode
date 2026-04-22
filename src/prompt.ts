import fs from "node:fs";
import path from "node:path";

const AGENTS_FILE_NAME = "AGENTS.md";
const MAX_AGENTS_BYTES = 20_000;

type BuildSystemPromptOptions = {
  workdir: string;
  skillDescriptions: string;
  mcpInstructions: string;
};

// 将项目约束文件注入到 prompt 中，帮助模型在每轮开始前就拿到仓库约定。
function readProjectAgentsInstructions(workdir: string): string {
  const agentsPath = path.join(workdir, AGENTS_FILE_NAME);
  if (!fs.existsSync(agentsPath)) {
    return "";
  }

  const raw = fs.readFileSync(agentsPath, "utf8").trim();
  if (!raw) {
    return "";
  }

  const content = raw.length > MAX_AGENTS_BYTES
    ? `${raw.slice(0, MAX_AGENTS_BYTES)}\n\n[AGENTS.md truncated due to size.]`
    : raw;

  return `Project instructions from ${agentsPath}:\n\n${content}`;
}

// system prompt 只负责拼装静态上下文，避免在 UI 层夹杂文件读取逻辑。
export function buildSystemPrompt({
  workdir,
  skillDescriptions,
  mcpInstructions,
}: BuildSystemPromptOptions): string {
  const parts = [
    `You are a coding agent at ${workdir}. Use tools to solve tasks. Act, don't explain.`,
    "Use load_skill to access specialized knowledge before tackling unfamiliar topics.",
    `Skills available:\n${skillDescriptions}`,
    mcpInstructions,
  ];

  const agentsInstructions = readProjectAgentsInstructions(workdir);
  if (agentsInstructions) {
    parts.push(agentsInstructions);
  }

  return parts.join("\n\n");
}
