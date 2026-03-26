import fs from "node:fs";
import path from "node:path";

type SkillMeta = {
  name: string;
  description: string;
  tags?: string;
};

type SkillEntry = {
  meta: SkillMeta;
  body: string;
  path: string;
};

export class SkillLoader {
  private skills: Record<string, SkillEntry> = {};

  constructor(skillsDirs: string[]) {
    // Load in order: earlier directories have lower priority, later ones override
    for (const dir of skillsDirs) {
      this.loadAll(dir);
    }
  }

  private loadAll(skillsDir: string): void {
    if (!fs.existsSync(skillsDir)) return;

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const text = fs.readFileSync(skillFile, "utf8");
      const { meta, body } = this.parseFrontmatter(text, entry.name);
      this.skills[meta.name] = { meta, body, path: skillFile };
    }
  }

  private parseFrontmatter(text: string, fallbackName: string): { meta: SkillMeta; body: string } {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
    if (!match) {
      return { meta: { name: fallbackName, description: "No description" }, body: text.trim() };
    }

    const meta: Record<string, string> = {};
    for (const line of match[1].trim().split("\n")) {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      meta[line.slice(0, colonIndex).trim()] = line.slice(colonIndex + 1).trim();
    }

    return {
      meta: {
        name: meta.name || fallbackName,
        description: meta.description || "No description",
        tags: meta.tags,
      },
      body: match[2].trim(),
    };
  }

  getDescriptions(): string {
    const names = Object.keys(this.skills);
    if (names.length === 0) return "(no skills available)";

    return names
      .map((name) => {
        const { meta } = this.skills[name];
        let line = ` - ${name}: ${meta.description}`;
        if (meta.tags) line += ` [${meta.tags}]`;
        return line;
      })
      .join("\n");
  }

  getContent(name: string): string {
    const skill = this.skills[name];
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}
