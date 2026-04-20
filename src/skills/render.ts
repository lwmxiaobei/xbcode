import type { PromptCommand, SkillDescriptor } from "./types.js";

export function renderPromptCommand(command: PromptCommand, args?: string): string {
  const parts: string[] = [`<skill name="${command.name}">`];

  if (command.baseDir) {
    parts.push(`Base directory for this skill: ${command.baseDir}`);
  }
  if (command.whenToUse) {
    parts.push(`When to use: ${command.whenToUse}`);
  }
  if (command.allowedTools.length > 0) {
    parts.push(`Allowed tools: ${command.allowedTools.join(", ")}`);
  }
  if (command.argumentHint) {
    parts.push(`Argument hint: ${command.argumentHint}`);
  }
  if (args && args.trim()) {
    parts.push(`User args:\n${args.trim()}`);
  }

  parts.push(command.content);
  parts.push("</skill>");
  return parts.join("\n\n");
}

export function renderSkillContent(skill: SkillDescriptor, args?: string): string {
  return renderPromptCommand({
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    whenToUse: skill.whenToUse,
    allowedTools: skill.allowedTools,
    argumentHint: skill.argumentHint,
    content: skill.body,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    source: "skill",
  }, args);
}
