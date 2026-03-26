#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".codemini");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");

if (fs.existsSync(SETTINGS_PATH)) {
  process.exit(0);
}

const defaultSettings = {
  providers: {
    openai: {
      models: ["gpt-4.1", "gpt-4.1-mini", "o3-mini"],
      apiKey: "",
      baseURL: "https://api.openai.com/v1",
      apiMode: "responses",
    },
  },
  defaultProvider: "openai",
  showThinking: false,
};

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2) + "\n", "utf8");

console.log(`[codemini] Created default config at ${SETTINGS_PATH}`);
