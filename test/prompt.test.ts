import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSystemPrompt } from "../src/prompt.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "code-agent-prompt-"));
}

test("buildSystemPrompt appends AGENTS.md contents with source label when present", () => {
  const root = makeTempDir();
  const agentsPath = path.join(root, "AGENTS.md");
  fs.writeFileSync(agentsPath, "# Team Rules\n\nUse apply_patch.\n", "utf8");

  const prompt = buildSystemPrompt({
    workdir: root,
    skillDescriptions: "review: Review changes",
    mcpInstructions: "No MCP servers configured.",
  });

  assert.match(prompt, /You are a coding agent at /);
  assert.match(prompt, /Skills available:\nreview: Review changes/);
  assert.match(
    prompt,
    new RegExp(`Project instructions from ${agentsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`),
  );
  assert.match(prompt, /# Team Rules\n\nUse apply_patch\./);
});

test("buildSystemPrompt skips AGENTS.md section when file is absent", () => {
  const root = makeTempDir();

  const prompt = buildSystemPrompt({
    workdir: root,
    skillDescriptions: "review: Review changes",
    mcpInstructions: "No MCP servers configured.",
  });

  assert.doesNotMatch(prompt, /Project instructions from .*AGENTS\.md:/);
});
