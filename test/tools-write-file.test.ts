import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { BASE_TOOL_HANDLERS } from "../src/tools.js";

const TMP_ROOT = ".test-tmp-write-file";

function snapshot(filePath: string): Buffer | null {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
}

function cleanup(): void {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
}

test("write_file rejects a missing path without touching the accidental undefined file", () => {
  const accidentalPath = path.resolve("undefined");
  const before = snapshot(accidentalPath);

  const result = BASE_TOOL_HANDLERS.write_file({ content: "hello" });

  assert.match(String(result), /^Error: Invalid arguments for write_file: path must be a non-empty string/);
  assert.deepEqual(snapshot(accidentalPath), before);
});

test("write_file rejects a missing content field", () => {
  const target = path.join(TMP_ROOT, "missing-content.md");
  try {
    const result = BASE_TOOL_HANDLERS.write_file({ path: target });

    assert.match(String(result), /^Error: Invalid arguments for write_file: content must be a string/);
    assert.equal(fs.existsSync(target), false);
  } finally {
    cleanup();
  }
});

test("write_file allows an empty content string", async () => {
  const target = path.join(TMP_ROOT, "empty.md");
  try {
    // 写操作现在经过 file mutation queue，因此是异步的。
    const result = await BASE_TOOL_HANDLERS.write_file({ path: target, content: "" });

    assert.match(String(result), /^Wrote 0 bytes to /);
    assert.equal(fs.readFileSync(target, "utf8"), "");
  } finally {
    cleanup();
  }
});

test("write_file serializes concurrent writes to the same file", async () => {
  const target = path.join(TMP_ROOT, "concurrent.txt");
  try {
    // 并发写同一个文件：队列保证它们逐个落盘，最终内容是某一次的完整结果，
    // 而不是两次写交错出来的半截内容。
    const writes = ["a".repeat(2000), "b".repeat(2000), "c".repeat(2000)].map((content) =>
      BASE_TOOL_HANDLERS.write_file({ path: target, content }),
    );
    await Promise.all(writes);

    const finalContent = fs.readFileSync(target, "utf8");
    assert.equal(finalContent.length, 2000);
    assert.equal(new Set(finalContent).size, 1);
  } finally {
    cleanup();
  }
});
