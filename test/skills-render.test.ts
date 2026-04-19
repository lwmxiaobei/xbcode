import test from "node:test";
import assert from "node:assert/strict";

import type { SkillDescriptor } from "../src/skills/types.js";
import { renderSkillContent } from "../src/skills/render.js";

const descriptor: SkillDescriptor = {
  name: "pdf",
  description: "Process PDF files",
  tags: "documents",
  whenToUse: "When the user asks about PDF files",
  allowedTools: ["bash"],
  argumentHint: "path-or-task",
  body: "Inspect the PDF and extract the relevant pages.",
  filePath: "/tmp/skills/pdf/SKILL.md",
  baseDir: "/tmp/skills/pdf",
};

test("renderSkillContent includes runtime metadata and user args", () => {
  const rendered = renderSkillContent(descriptor, "docs/spec.pdf");

  assert.match(rendered, /<skill name="pdf">/);
  assert.match(rendered, /Base directory for this skill: \/tmp\/skills\/pdf/);
  assert.match(rendered, /When to use: When the user asks about PDF files/);
  assert.match(rendered, /Allowed tools: bash/);
  assert.match(rendered, /Argument hint: path-or-task/);
  assert.match(rendered, /User args:\s+docs\/spec\.pdf/);
  assert.match(rendered, /Inspect the PDF and extract the relevant pages\./);
});

test("renderSkillContent omits optional sections when metadata is absent", () => {
  const rendered = renderSkillContent(
    {
      ...descriptor,
      whenToUse: undefined,
      allowedTools: [],
      argumentHint: undefined,
      baseDir: undefined,
    },
    "",
  );

  assert.doesNotMatch(rendered, /Base directory for this skill:/);
  assert.doesNotMatch(rendered, /When to use:/);
  assert.doesNotMatch(rendered, /Allowed tools:/);
  assert.doesNotMatch(rendered, /Argument hint:/);
  assert.doesNotMatch(rendered, /User args:/);
});
