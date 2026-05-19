import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ImageAttachment } from "./types.js";

const execFileAsync = promisify(execFile);
const TMP_DIR = path.join(os.tmpdir(), "xbcode-images");

function ensureTmpDir(): void {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

export function isSupportedImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext);
}

export function readImageAttachmentFromPath(filePath: string): ImageAttachment {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Image file not found: ${filePath}`);
  }
  if (!isSupportedImagePath(absolutePath)) {
    throw new Error(`Unsupported image file: ${filePath}`);
  }

  const base64Data = fs.readFileSync(absolutePath).toString("base64");
  return {
    path: absolutePath,
    mimeType: guessMimeType(absolutePath),
    base64Data,
  };
}

export function extractImagePathsFromText(input: string): { attachments: ImageAttachment[]; remainingText: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { attachments: [], remainingText: input };
  }

  const candidates = trimmed
    .split(/\s+/)
    .map((part) => part.replace(/^['\"]|['\"]$/g, "").replace(/\\ /g, " "));

  const attachments: ImageAttachment[] = [];
  const consumed = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate.startsWith("/") && !candidate.startsWith("./") && !candidate.startsWith("../")) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile() || !isSupportedImagePath(resolved)) {
      continue;
    }
    attachments.push(readImageAttachmentFromPath(resolved));
    consumed.add(candidate);
    consumed.add(candidate.replace(/ /g, "\\ "));
  }

  if (attachments.length === 0) {
    return { attachments, remainingText: input };
  }

  const remainingWords = trimmed
    .split(/\s+/)
    .filter((part) => !consumed.has(part.replace(/^['\"]|['\"]$/g, "")));

  return {
    attachments,
    remainingText: remainingWords.join(" ").trim(),
  };
}

export async function importClipboardImageMacos(): Promise<ImageAttachment> {
  if (process.platform !== "darwin") {
    throw new Error("Clipboard image import is only supported on macOS.");
  }

  ensureTmpDir();
  const targetPath = path.join(TMP_DIR, `clipboard-${Date.now()}.png`);

  try {
    await execFileAsync("pngpaste", [targetPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      throw new Error("pngpaste is not installed. Install it with: brew install pngpaste");
    }
    throw new Error("Clipboard does not contain an image.");
  }

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    throw new Error("Clipboard does not contain an image.");
  }

  return readImageAttachmentFromPath(targetPath);
}
