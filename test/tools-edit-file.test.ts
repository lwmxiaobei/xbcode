import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { BASE_TOOL_HANDLERS } from "../src/tools.js";
import {
  applyEditsToNormalizedContent,
  fuzzyFindText,
  normalizeForFuzzyMatch,
  stripBom,
  detectLineEnding,
} from "../src/tools/edit-diff.js";
import type { ToolResult } from "../src/types.js";

// =============== 纯函数测试 ===============

test("normalizeForFuzzyMatch 归一化引号、破折号、特殊空格与行尾空白", () => {
  assert.equal(normalizeForFuzzyMatch("“hello”"), '"hello"');
  assert.equal(normalizeForFuzzyMatch("don’t"), "don't");
  assert.equal(normalizeForFuzzyMatch("a—b"), "a-b");
  assert.equal(normalizeForFuzzyMatch("a b"), "a b");
  assert.equal(normalizeForFuzzyMatch("foo   \nbar\t"), "foo\nbar");
});

test("normalizeForFuzzyMatch 不动行首缩进（Python/YAML 缩进有语义）", () => {
  assert.equal(normalizeForFuzzyMatch("    return 1"), "    return 1");
});

test("fuzzyFindText 优先精确匹配", () => {
  const result = fuzzyFindText("function foo() { return 1; }", "return 1");
  assert.equal(result.found, true);
  assert.equal(result.usedFuzzyMatch, false);
});

test("fuzzyFindText 在弯引号/直引号不一致时仍能命中", () => {
  const result = fuzzyFindText("const msg = “hello”;", 'const msg = "hello";');
  assert.equal(result.found, true);
  assert.equal(result.usedFuzzyMatch, true);
});

test("stripBom 与 detectLineEnding", () => {
  assert.deepEqual(stripBom("﻿abc"), { bom: "﻿", text: "abc" });
  assert.deepEqual(stripBom("abc"), { bom: "", text: "abc" });
  assert.equal(detectLineEnding("a\r\nb"), "\r\n");
  assert.equal(detectLineEnding("a\nb"), "\n");
  assert.equal(detectLineEnding("abc"), "\n");
});

test("applyEditsToNormalizedContent 拒绝出现多次的 old_text", () => {
  assert.throws(
    () => applyEditsToNormalizedContent("x\nx\n", [{ oldText: "x", newText: "y" }], "a.ts"),
    /Found 2 occurrences/,
  );
});

test("applyEditsToNormalizedContent 拒绝互相重叠的 edits", () => {
  assert.throws(
    () =>
      applyEditsToNormalizedContent(
        "alpha beta gamma",
        [
          { oldText: "alpha beta", newText: "A" },
          { oldText: "beta gamma", newText: "B" },
        ],
        "a.ts",
      ),
    /overlap/,
  );
});

test("applyEditsToNormalizedContent 的每条 edit 都对原始内容匹配", () => {
  // 第二条 edit 的 old_text 在「第一条应用之后」已经不存在了，
  // 但因为都对原始内容匹配，所以两条都能命中。
  const result = applyEditsToNormalizedContent(
    "const a = 1;\nconst b = 2;\n",
    [
      { oldText: "const a = 1;", newText: "const a = 10;" },
      { oldText: "const b = 2;", newText: "const b = 20;" },
    ],
    "a.ts",
  );
  assert.equal(result.newContent, "const a = 10;\nconst b = 20;\n");
});

test("模糊匹配只重写被命中的行，其余行保留原始字节", () => {
  // 第 1 行有尾随空白、第 3 行有弯引号；只改第 3 行时，第 1 行必须原样保留。
  const original = "const keep = 1;   \nconst other = 2;\nconst msg = “hi”;\n";
  const result = applyEditsToNormalizedContent(
    original,
    [{ oldText: 'const msg = "hi";', newText: 'const msg = "bye";' }],
    "a.ts",
  );
  assert.equal(result.newContent, "const keep = 1;   \nconst other = 2;\nconst msg = \"bye\";\n");
});

// =============== edit_file 集成测试 ===============

const TMP_ROOT = ".test-tmp";

function setupTmpFile(name: string, content: string): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const filePath = path.join(TMP_ROOT, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function cleanup(): void {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
}

async function runEditTool(args: Record<string, unknown>): Promise<ToolResult> {
  const result = await BASE_TOOL_HANDLERS.edit_file(args);
  return typeof result === "string" ? { output: result } : result;
}

test("edit_file 精确替换", async () => {
  const filePath = setupTmpFile("a.ts", "const x = 1;\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [{ old_text: "x = 1", new_text: "x = 2" }],
    });
    assert.match(result.output, /^Edited /);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const x = 2;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 一次调用改多处", async () => {
  const filePath = setupTmpFile("multi.ts", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [
        { old_text: "const a = 1;", new_text: "const a = 10;" },
        { old_text: "const c = 3;", new_text: "const c = 30;" },
      ],
    });
    assert.match(result.output, /2 blocks replaced/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const a = 10;\nconst b = 2;\nconst c = 30;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 在 old_text 出现多次时报错且不落盘", async () => {
  const filePath = setupTmpFile("dup.ts", "log();\nlog();\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [{ old_text: "log();", new_text: "debug();" }],
    });
    assert.match(result.output, /Found 2 occurrences/);
    // 关键：报错时文件必须一个字节都没动。
    assert.equal(fs.readFileSync(filePath, "utf8"), "log();\nlog();\n");
  } finally {
    cleanup();
  }
});

test("edit_file 任意一条 edit 失败则整体不落盘", async () => {
  const filePath = setupTmpFile("atomic.ts", "const a = 1;\nconst b = 2;\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [
        { old_text: "const a = 1;", new_text: "const a = 10;" },
        { old_text: "does not exist", new_text: "whatever" },
      ],
    });
    assert.match(result.output, /Could not find edits\[1\]/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const a = 1;\nconst b = 2;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 保留 CRLF 行尾", async () => {
  const filePath = setupTmpFile("crlf.ts", "const a = 1;\r\nconst b = 2;\r\n");
  try {
    await runEditTool({
      path: filePath,
      edits: [{ old_text: "const a = 1;", new_text: "const a = 10;" }],
    });
    assert.equal(fs.readFileSync(filePath, "utf8"), "const a = 10;\r\nconst b = 2;\r\n");
  } finally {
    cleanup();
  }
});

test("edit_file 保留 BOM", async () => {
  const filePath = setupTmpFile("bom.ts", "﻿const a = 1;\n");
  try {
    await runEditTool({
      path: filePath,
      edits: [{ old_text: "const a = 1;", new_text: "const a = 10;" }],
    });
    assert.equal(fs.readFileSync(filePath, "utf8"), "﻿const a = 10;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 弯引号文件被直引号 old_text 命中", async () => {
  const filePath = setupTmpFile("b.ts", "const m = “hi”;\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [{ old_text: '"hi"', new_text: '"bye"' }],
    });
    assert.match(result.output, /^Edited /);
    assert.equal(fs.readFileSync(filePath, "utf8"), 'const m = "bye";\n');
  } finally {
    cleanup();
  }
});

test("edit_file 找不到 old_text 时返回明确错误", async () => {
  const filePath = setupTmpFile("d.ts", "alpha");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [{ old_text: "beta", new_text: "gamma" }],
    });
    assert.match(result.output, /Could not find the exact text/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "alpha");
  } finally {
    cleanup();
  }
});

test("edit_file 缺 edits 与 old_text 时被参数校验拦下", async () => {
  const filePath = setupTmpFile("missing-old.ts", "const value = undefined;\n");
  try {
    const result = await runEditTool({ path: filePath, new_text: "patched" });

    assert.match(result.output, /^Error: Invalid arguments for edit_file: at least one of edits, old_text is required/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const value = undefined;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 当 old_text === new_text 时报错（防空替换）", async () => {
  const filePath = setupTmpFile("e.ts", "same\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [{ old_text: "same", new_text: "same" }],
    });
    assert.match(result.output, /No changes made/);
  } finally {
    cleanup();
  }
});

test("edit_file new_text 含 $&、$1 时不会被当成正则替换序列", async () => {
  const filePath = setupTmpFile("f.ts", "OLD");
  try {
    await runEditTool({
      path: filePath,
      edits: [{ old_text: "OLD", new_text: "$& $1 literal" }],
    });
    assert.equal(fs.readFileSync(filePath, "utf8"), "$& $1 literal");
  } finally {
    cleanup();
  }
});

test("edit_file 兼容旧的顶层 old_text / new_text 形态", async () => {
  const filePath = setupTmpFile("legacy.ts", "const x = 1;\n");
  try {
    const result = await runEditTool({ path: filePath, old_text: "x = 1", new_text: "x = 2" });
    assert.match(result.output, /^Edited /);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const x = 2;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 兼容把 edits 序列化成 JSON 字符串的模型", async () => {
  const filePath = setupTmpFile("json-edits.ts", "const x = 1;\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: JSON.stringify([{ old_text: "x = 1", new_text: "x = 2" }]),
    });
    assert.match(result.output, /^Edited /);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const x = 2;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 返回带行号的 diff 和 unified patch", async () => {
  const filePath = setupTmpFile("diff.ts", "const a = 1;\nconst b = 2;\n");
  try {
    const result = await runEditTool({
      path: filePath,
      edits: [{ old_text: "const a = 1;", new_text: "const a = 10;" }],
    });

    assert.ok(result.details?.diff, "expected a display diff");
    assert.match(result.details!.diff!, /-\s*1 const a = 1;/);
    assert.match(result.details!.diff!, /\+\s*1 const a = 10;/);
    assert.equal(result.details?.firstChangedLine, 1);

    assert.ok(result.details?.patch, "expected a unified patch");
    assert.match(result.details!.patch!, /^---/m);
    assert.match(result.details!.patch!, /^@@/m);
  } finally {
    cleanup();
  }
});
