import fs from "node:fs";
import path from "node:path";
import { debugLog } from "../utils.js";
import { buildSkillDescriptor, parseSkillFile } from "./frontmatter.js";
import { renderSkillContent } from "./render.js";
import type { SkillDescriptor } from "./types.js";

export class SkillLoader {
  private skills = new Map<string, SkillDescriptor>();

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
      this.skills.set(descriptor.name, descriptor);
    }
  }

  getDescriptions(): string {
    const skills = [...this.skills.values()];
    debugLog("skills=%s", skills);
    if (skills.length === 0) return "(no skills available)";

    return skills
      .map((skill) => {
        let line = ` - ${skill.name}: ${skill.description}`;
        if (skill.tags) line += ` [${skill.tags}]`;
        return line;
      })
      .join("\n");
  }

  getSkill(name: string): SkillDescriptor | undefined {
    return this.skills.get(name);
  }

  renderSkill(name: string, args?: string): string {
    const skill = this.skills.get(name);
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${[...this.skills.keys()].join(", ")}`;
    }
    return renderSkillContent(skill, args);
  }
}
