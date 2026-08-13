import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { BASE_TOOL_HANDLERS } from "../src/tools.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/tools/file-truncate.js";
import { detectSupportedImageMimeType, readImageDimensions } from "../src/tools/image.js";
import type { ImageAttachment } from "../src/types.js";

const TMP_ROOT = ".test-tmp-read-file";

function setupTmpFile(name: string, content: string | Buffer): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const filePath = path.join(TMP_ROOT, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function cleanup(): void {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
}

async function runReadTool(args: Record<string, unknown>, control?: Record<string, unknown>): Promise<string> {
  const result = await BASE_TOOL_HANDLERS.read_file(args, control as never);
  return typeof result === "string" ? result : result.output;
}

// 构造一个最小但合法的 PNG：签名 + IHDR(13 字节) + 空 IDAT。
// 用真实字节而不是 mock，是为了让类型嗅探和尺寸解析走的是生产路径。
function buildMinimalPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13, 0);
  const ihdr = Buffer.concat([ihdrLength, Buffer.from("IHDR"), ihdrData, Buffer.alloc(4)]);

  const idat = Buffer.concat([Buffer.alloc(4), Buffer.from("IDAT"), Buffer.alloc(4)]);

  return Buffer.concat([signature, ihdr, idat]);
}

// =============== 文本读取 ===============

test("read_file 读取完整文件", async () => {
  const filePath = setupTmpFile("plain.txt", "line1\nline2\nline3\n");
  try {
    const output = await runReadTool({ path: filePath });
    assert.equal(output, "line1\nline2\nline3\n");
  } finally {
    cleanup();
  }
});

test("read_file 的 offset 是 1-indexed", async () => {
  const filePath = setupTmpFile("offset.txt", "line1\nline2\nline3\n");
  try {
    const output = await runReadTool({ path: filePath, offset: 2 });
    assert.match(output, /^line2\nline3/);
    assert.doesNotMatch(output, /line1/);
  } finally {
    cleanup();
  }
});

test("read_file 的 limit 截断后提示剩余行数与下一个 offset", async () => {
  const filePath = setupTmpFile("limit.txt", "a\nb\nc\nd\ne\n");
  try {
    const output = await runReadTool({ path: filePath, limit: 2 });
    assert.match(output, /^a\nb/);
    assert.match(output, /\[4 more lines in file\. Use offset=3 to continue\.\]/);
  } finally {
    cleanup();
  }
});

test("read_file 的 offset 越界时给出明确错误", async () => {
  const filePath = setupTmpFile("short.txt", "only\n");
  try {
    const output = await runReadTool({ path: filePath, offset: 99 });
    assert.match(output, /^Error: offset 99 is beyond end of file/);
  } finally {
    cleanup();
  }
});

test("read_file 触发行数上限时给出可直接续读的 offset", async () => {
  const totalLines = DEFAULT_MAX_LINES + 10;
  const content = Array.from({ length: totalLines }, (_, i) => `line${i + 1}`).join("\n");
  const filePath = setupTmpFile("many-lines.txt", content);
  try {
    const output = await runReadTool({ path: filePath });
    assert.match(output, new RegExp(`Showing lines 1-${DEFAULT_MAX_LINES} of ${totalLines}`));
    assert.match(output, new RegExp(`Use offset=${DEFAULT_MAX_LINES + 1} to continue`));
    assert.match(output, /line limit/);

    // 按提示的 offset 续读，应该正好接上被截断的位置。
    const continued = await runReadTool({ path: filePath, offset: DEFAULT_MAX_LINES + 1 });
    assert.match(continued, new RegExp(`^line${DEFAULT_MAX_LINES + 1}\\n`));
  } finally {
    cleanup();
  }
});

test("read_file 触发字节上限时按字节报告截断", async () => {
  // 每行 1KB，100 行 = 100KB，会先撞上 50KB 的字节上限而不是 2000 行的行数上限。
  const content = Array.from({ length: 100 }, () => "x".repeat(1024)).join("\n");
  const filePath = setupTmpFile("big-bytes.txt", content);
  try {
    const output = await runReadTool({ path: filePath });
    assert.match(output, /Showing lines 1-\d+ of 100/);
    assert.match(output, /50\.0KB limit/);
    assert.ok(Buffer.byteLength(output, "utf8") < DEFAULT_MAX_BYTES * 1.1);
  } finally {
    cleanup();
  }
});

test("read_file 遇到单行超过字节上限时给出 sed 退路而不是空手而归", async () => {
  const filePath = setupTmpFile("one-huge-line.txt", "y".repeat(DEFAULT_MAX_BYTES + 100));
  try {
    const output = await runReadTool({ path: filePath });
    assert.match(output, /^\[Line 1 is [\d.]+KB, over the 50\.0KB limit\./);
    assert.match(output, /sed -n '1p'/);
  } finally {
    cleanup();
  }
});

test("read_file 对不存在的文件返回错误而不是抛异常", async () => {
  const output = await runReadTool({ path: path.join(TMP_ROOT, "nope.txt") });
  assert.match(output, /^Error: /);
});

// =============== 图片读取 ===============

test("detectSupportedImageMimeType 按文件头识别 PNG", () => {
  const png = buildMinimalPng(120, 80);
  assert.equal(detectSupportedImageMimeType(png), "image/png");
  assert.deepEqual(readImageDimensions(png, "image/png"), { width: 120, height: 80 });
});

test("detectSupportedImageMimeType 对普通文本返回 null", () => {
  assert.equal(detectSupportedImageMimeType(Buffer.from("just text")), null);
});

test("read_file 读到图片时把它挂进待发队列", async () => {
  const filePath = setupTmpFile("pic.png", buildMinimalPng(120, 80));
  try {
    const pendingImages: ImageAttachment[] = [];
    const output = await runReadTool({ path: filePath }, { model: "gpt-4.1", pendingImages });

    assert.match(output, /^Read image file \[image\/png\]/);
    assert.match(output, /\[Image dimensions: 120x80\]/);
    assert.match(output, /\[Image attached to the conversation\.\]/);

    assert.equal(pendingImages.length, 1);
    assert.equal(pendingImages[0].mimeType, "image/png");
    assert.ok(pendingImages[0].base64Data.length > 0);
  } finally {
    cleanup();
  }
});

test("read_file 对纯文本模型不发送图片，只回文字说明", async () => {
  const filePath = setupTmpFile("pic2.png", buildMinimalPng(10, 10));
  try {
    const pendingImages: ImageAttachment[] = [];
    const output = await runReadTool({ path: filePath }, { model: "deepseek-chat", pendingImages });

    assert.match(output, /does not accept image input/);
    assert.equal(pendingImages.length, 0);
  } finally {
    cleanup();
  }
});
