import fs from "node:fs";
import path from "node:path";
import { debugLog } from "../utils.js";
import { buildSkillDescriptor, parseSkillFile } from "./frontmatter.js";
import { renderPromptCommand } from "./render.js";
import type { PromptCommand, SkillDescriptor } from "./types.js";

export class SkillLoader {
  private commands = new Map<string, PromptCommand>();

  constructor(skillsDirs: string[]) {
    for (const dir of skillsDirs) {
      this.loadAll(dir);
    }
  }

  private loadAll(skillsDir: string): void {
    if (!fs.existsSync(skillsDir)) return;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;

      const baseDir = path.join(skillsDir, entry.name);
      const filePath = path.join(baseDir, "SKILL.md");
      if (!fs.existsSync(filePath)) continue;

      const text = fs.readFileSync(filePath, "utf8");
      const { meta, body } = parseSkillFile(text);
      const descriptor = buildSkillDescriptor(meta, body, entry.name, filePath, baseDir);
      this.commands.set(descriptor.name, this.toPromptCommand(descriptor));
    }
  }

  private toPromptCommand(skill: SkillDescriptor): PromptCommand {
    return {
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      whenToUse: skill.whenToUse,
      allowedTools: [...skill.allowedTools],
      argumentHint: skill.argumentHint,
      content: skill.body,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source: "skill",
    };
  }

  getPromptCommands(): PromptCommand[] {
    return [...this.commands.values()];
  }

  getDescriptions(): string {
    const commands = this.getPromptCommands();
    debugLog("promptCommands=%s", commands);
    if (commands.length === 0) return "(no skills available)";

    return commands
      .map((command) => {
        let line = ` - ${command.name}: ${command.description}`;
        if (command.tags) line += ` [${command.tags}]`;
        return line;
      })
      .join("\n");
  }

  getSkill(name: string): SkillDescriptor | undefined {
    const command = this.commands.get(name);
    if (!command) {
      return undefined;
    }

    return {
      name: command.name,
      description: command.description,
      tags: command.tags,
      whenToUse: command.whenToUse,
      allowedTools: [...command.allowedTools],
      argumentHint: command.argumentHint,
      body: command.content,
      filePath: command.filePath,
      baseDir: command.baseDir,
    };
  }

  getCommand(name: string): PromptCommand | undefined {
    return this.commands.get(name);
  }

  renderSkill(name: string, args?: string): string {
    const command = this.commands.get(name);
    if (!command) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.commands.keys()].join(", ")}`;
    }
    return renderPromptCommand(command, args);
  }
}
