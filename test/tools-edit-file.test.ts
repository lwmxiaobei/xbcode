import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  BASE_TOOL_HANDLERS,
  findActualOldText,
  normalizeQuotes,
  stripTrailingWhitespacePerLine,
} from "../src/tools.js";

// =============== 纯函数测试 ===============

test("normalizeQuotes 把弯引号转成直引号", () => {
  assert.equal(normalizeQuotes("“hello”"), '"hello"');
  assert.equal(normalizeQuotes("don’t"), "don't");
  assert.equal(normalizeQuotes("‘x’"), "'x'");
  // 已经是直引号的不变
  assert.equal(normalizeQuotes('"hi"'), '"hi"');
});

test("findActualOldText 精确匹配", () => {
  const content = "function foo() { return 1; }";
  assert.equal(findActualOldText(content, "return 1"), "return 1");
});

test("findActualOldText 通过引号归一化命中（文件弯引号 vs 模型直引号）", () => {
  const content = "const msg = “hello”;";
  // 模型给的是直引号
  const found = findActualOldText(content, '"hello"');
  // 取出的应该是文件中实际的弯引号字符串
  assert.equal(found, "“hello”");
});

test("findActualOldText 通过引号归一化命中（文件直引号 vs 模型弯引号）", () => {
  const content = 'const msg = "hello";';
  const found = findActualOldText(content, "“hello”");
  assert.equal(found, '"hello"');
});

test("findActualOldText 找不到时返回 null", () => {
  const content = "abc def ghi";
  assert.equal(findActualOldText(content, "xyz"), null);
});

test("findActualOldText 不做空白模糊匹配（保留代码语义）", () => {
  // 多空格不应被无视 —— Python/YAML 缩进有语义
  const content = "if (x) {\n    return 1;\n}";
  // 模型给的少了一个空格
  assert.equal(findActualOldText(content, "if (x) {\n   return 1;\n}"), null);
});

test("stripTrailingWhitespacePerLine 剥每行行尾空白，保留换行", () => {
  assert.equal(stripTrailingWhitespacePerLine("foo   \nbar\t\nbaz"), "foo\nbar\nbaz");
  assert.equal(stripTrailingWhitespacePerLine("a\r\nb  \r\nc"), "a\r\nb\r\nc");
  // 行内空白不动
  assert.equal(stripTrailingWhitespacePerLine("a  b  \nc"), "a  b\nc");
});

// =============== edit_file 集成测试（通过 BASE_TOOL_HANDLERS） ===============

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

test("edit_file 精确替换", () => {
  const filePath = setupTmpFile("a.ts", "const x = 1;\n");
  try {
    const result = BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      old_text: "x = 1",
      new_text: "x = 2",
    });
    assert.match(String(result), /^Edited /);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const x = 2;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 弯引号文件被直引号 old_text 命中", () => {
  const filePath = setupTmpFile("b.ts", "const m = “hi”;\n");
  try {
    const result = BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      old_text: '"hi"',
      new_text: '"bye"',
    });
    assert.match(String(result), /^Edited /);
    // 替换后应使用 new_text 的引号原样写入
    assert.equal(fs.readFileSync(filePath, "utf8"), 'const m = "bye";\n');
  } finally {
    cleanup();
  }
});

test("edit_file 默认剥掉 new_text 行尾空白", () => {
  const filePath = setupTmpFile("c.ts", "foo\n");
  try {
    BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      old_text: "foo",
      new_text: "foo   \nbar  ",
    });
    assert.equal(fs.readFileSync(filePath, "utf8"), "foo\nbar\n");
  } finally {
    cleanup();
  }
});

test("edit_file 在 .md 文件中保留行尾双空格（markdown 硬换行）", () => {
  const filePath = setupTmpFile("doc.md", "line1\n");
  try {
    BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      old_text: "line1",
      new_text: "line1  \nline2",
    });
    // .md 文件不剥行尾空白
    assert.equal(fs.readFileSync(filePath, "utf8"), "line1  \nline2\n");
  } finally {
    cleanup();
  }
});

test("edit_file 找不到 old_text 时返回明确错误", () => {
  const filePath = setupTmpFile("d.ts", "alpha");
  try {
    const result = BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      old_text: "beta",
      new_text: "gamma",
    });
    assert.match(String(result), /String not found/);
    // 文件未被修改
    assert.equal(fs.readFileSync(filePath, "utf8"), "alpha");
  } finally {
    cleanup();
  }
});

test("edit_file 缺 old_text 时不会把字符串 undefined 当成待替换内容", () => {
  const filePath = setupTmpFile("missing-old.ts", "const value = undefined;\n");
  try {
    const result = BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      new_text: "patched",
    });

    assert.match(String(result), /^Error: Invalid arguments for edit_file: old_text must be a non-empty string/);
    assert.equal(fs.readFileSync(filePath, "utf8"), "const value = undefined;\n");
  } finally {
    cleanup();
  }
});

test("edit_file 当 old_text === new_text 时报错（防空替换）", () => {
  const filePath = setupTmpFile("e.ts", "same\n");
  try {
    const result = BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      old_text: "same",
      new_text: "same",
    });
    assert.match(String(result), /no changes/);
  } finally {
    cleanup();
  }
});

test("edit_file new_text 含 $&、$1 时不会被当成正则替换序列", () => {
  // String.prototype.replace(str, str) 会把 $& 当作"整个匹配"。
  // 我们用回调形式的 replace 避开这个坑。
  const filePath = setupTmpFile("f.ts", "OLD");
  try {
    BASE_TOOL_HANDLERS.edit_file({
      path: filePath,
      old_text: "OLD",
      new_text: "$& $1 literal",
    });
    assert.equal(fs.readFileSync(filePath, "utf8"), "$& $1 literal");
  } finally {
    cleanup();
  }
});
