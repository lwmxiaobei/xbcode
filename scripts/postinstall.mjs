#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".xbcode");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

if (fs.existsSync(SETTINGS_PATH)) {
  process.exit(0);
}

const defaultSettings = {
  providers: {
    openai: {
      models: ["gpt-5.4", "gpt-5.3-codex"],
      apiKey: "",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
    },
    volcengine: {
      models: [
        { id: "doubao-seed-2.0-code", name: "Doubao Seed 2.0 Code" },
        { id: "doubao-seed-2.0-pro", name: "Doubao Seed 2.0 Pro" },
        { id: "doubao-seed-2.0-lite", name: "Doubao Seed 2.0 Lite" },
        { id: "doubao-seed-code", name: "Doubao Seed Code" },
        { id: "minimax-m2.7", name: "MiniMax M2.7" },
        { id: "minimax-m3", name: "MiniMax M3" },
        { id: "glm-5.1", name: "GLM 5.1" },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
        { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        { id: "kimi-k2.6", name: "Kimi K2.6" },
      ],
      apiKey: "",
      baseURL: "https://ark.cn-beijing.volces.com/api/coding/v3",
      apiMode: "chat-completions",
    },
  },
  defaultProvider: "volcengine",
  defaultModel: "doubao-seed-2.0-code",
  showThinking: false,
};

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2) + "\n", "utf8");

console.log(`[xbcode] Created default config at ${SETTINGS_PATH}`);
