import type { SkillDescriptor, SkillFrontmatter } from "./types.js";

type ParsedSkillFile = {
  meta: SkillFrontmatter;
  body: string;
};

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseListValue(value: string): string[] {
  return stripWrappingQuotes(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseSkillFile(text: string): ParsedSkillFile {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text.trim() };
  }

  const meta: Record<string, string | string[]> = {};
  const lines = (match[1] ?? "").split(/\r?\n/);
  let currentListKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && currentListKey) {
      const existing = meta[currentListKey];
      const nextValue = stripWrappingQuotes(listMatch[1] ?? "");
      if (Array.isArray(existing)) {
        existing.push(nextValue);
      } else if (typeof existing === "string" && existing.length > 0) {
        meta[currentListKey] = [existing, nextValue];
      } else {
        meta[currentListKey] = [nextValue];
      }
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      currentListKey = null;
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();

    if (!rawValue) {
      meta[key] = [];
      currentListKey = key;
      continue;
    }

    if (key === "allowed-tools") {
      meta[key] = parseListValue(rawValue);
    } else {
      meta[key] = stripWrappingQuotes(rawValue);
    }
    currentListKey = null;
  }

  return {
    meta: meta as SkillFrontmatter,
    body: (match[2] ?? "").trim(),
  };
}

export function buildSkillDescriptor(
  meta: SkillFrontmatter,
  body: string,
  fallbackName: string,
  filePath: string,
  baseDir?: string,
): SkillDescriptor {
  const allowedTools = Array.isArray(meta["allowed-tools"])
    ? meta["allowed-tools"]
    : typeof meta["allowed-tools"] === "string"
      ? parseListValue(meta["allowed-tools"])
      : [];

  return {
    name: meta.name || fallbackName,
    description: meta.description || "No description",
    tags: meta.tags,
    whenToUse: meta.when_to_use,
    allowedTools,
    argumentHint: meta["argument-hint"],
    body,
    filePath,
    baseDir,
  };
}

