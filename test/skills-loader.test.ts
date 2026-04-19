import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SkillLoader } from "../src/skills/index.js";

function makeTempSkillsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "code-agent-skills-"));
}

test("SkillLoader parses richer frontmatter and exposes descriptions", () => {
  const root = makeTempSkillsDir();
  const skillDir = path.join(root, "review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: code-review
description: Review code for regressions
tags: development,quality
when_to_use: When reviewing diffs or suspicious behavior
allowed-tools: bash,read_file
argument-hint: diff-or-scope
---

# Review

Check the diff carefully.
`,
    "utf8",
  );

  const loader = new SkillLoader([root]);
  const descriptions = loader.getDescriptions();
  const descriptor = loader.getSkill("code-review");

  assert.match(descriptions, /code-review: Review code for regressions/);
  assert.match(descriptions, /\[development,quality\]/);
  assert.ok(descriptor);
  assert.equal(descriptor?.name, "code-review");
  assert.equal(descriptor?.description, "Review code for regressions");
  assert.equal(descriptor?.whenToUse, "When reviewing diffs or suspicious behavior");
  assert.deepEqual(descriptor?.allowedTools, ["bash", "read_file"]);
  assert.equal(descriptor?.argumentHint, "diff-or-scope");
  assert.equal(descriptor?.body.trim(), "# Review\n\nCheck the diff carefully.");
  assert.equal(descriptor?.baseDir, skillDir);
});

test("later skill directories override earlier ones by skill name", () => {
  const globalRoot = makeTempSkillsDir();
  const localRoot = makeTempSkillsDir();

  fs.mkdirSync(path.join(globalRoot, "pdf"), { recursive: true });
  fs.mkdirSync(path.join(localRoot, "pdf"), { recursive: true });

  fs.writeFileSync(
    path.join(globalRoot, "pdf", "SKILL.md"),
    `---
name: pdf
description: Global version
---

global body
`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(localRoot, "pdf", "SKILL.md"),
    `---
name: pdf
description: Local version
---

local body
`,
    "utf8",
  );

  const loader = new SkillLoader([globalRoot, localRoot]);
  const descriptor = loader.getSkill("pdf");

  assert.equal(descriptor?.description, "Local version");
  assert.equal(descriptor?.body.trim(), "local body");
  assert.equal(descriptor?.baseDir, path.join(localRoot, "pdf"));
});
