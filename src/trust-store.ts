import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRUST_DIR = path.join(os.homedir(), ".xbcode");
const TRUST_FILE = path.join(TRUST_DIR, "trusted.json");

function normalize(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

function readTrustedDirs(): string[] {
  try {
    const raw = fs.readFileSync(TRUST_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

export function isTrusted(dir: string): boolean {
  return readTrustedDirs().includes(normalize(dir));
}

export function markTrusted(dir: string): void {
  const target = normalize(dir);
  try {
    fs.mkdirSync(TRUST_DIR, { recursive: true });
    const dirs = readTrustedDirs();
    if (dirs.includes(target)) return;
    dirs.push(target);
    fs.writeFileSync(TRUST_FILE, JSON.stringify(dirs, null, 2));
  } catch (err) {
    console.error("[trust-store] failed to persist trust:", err);
  }
}
