import type { SkillDescriptor } from "./types.js";

export function renderSkillContent(skill: SkillDescriptor, args?: string): string {
  const parts: string[] = [`<skill name="${skill.name}">`];

  if (skill.baseDir) {
    parts.push(`Base directory for this skill: ${skill.baseDir}`);
  }
  if (skill.whenToUse) {
    parts.push(`When to use: ${skill.whenToUse}`);
  }
  if (skill.allowedTools.length > 0) {
    parts.push(`Allowed tools: ${skill.allowedTools.join(", ")}`);
  }
  if (skill.argumentHint) {
    parts.push(`Argument hint: ${skill.argumentHint}`);
  }
  if (args && args.trim()) {
    parts.push(`User args:\n${args.trim()}`);
  }

  parts.push(skill.body);
  parts.push("</skill>");
  return parts.join("\n\n");
}

