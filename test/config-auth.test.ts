import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  clearProviderCredentials,
  loadCredentialsFile,
  needsModelSelection,
  normalizeReasoningEffort,
  normalizeSettings,
  resolveProviderAuthState,
  resolveRuntimeAuth,
  shouldPromptForModelSelection,
  writeCredentialsFile,
  writeSettingsFile,
  updateProviderModels,
} from "../src/config.js";

test("resolveProviderAuthState prefers valid oauth credentials over apiKey", () => {
  const settings = normalizeSettings({
    providers: {
      openai: {
        models: ["gpt-5.4"],
        apiKey: "fallback-key",
        auth: { type: "oauth" },
      },
    },
  }, []);

  const state = resolveProviderAuthState(settings, "openai", {
    providers: {
      openai: {
        type: "oauth",
        access_token: "oauth-token",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    },
  });

  assert.equal(state.authMode, "oauth");
  assert.equal(state.bearerToken, "oauth-token");
});

test("writeCredentialsFile persists oauth credentials for a provider", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "xbcode-auth-"));
  const credentialsPath = join(tempDir, "credentials.json");

  await writeCredentialsFile(credentialsPath, {
    providers: {
      openai: {
        type: "oauth",
        access_token: "token",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    },
  });

  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(saved.providers.openai.access_token, "token");
});

test("resolveRuntimeAuth refreshes expired oauth token before falling back to apiKey", async () => {
  const settings = normalizeSettings({
    providers: {
      openai: {
        models: ["gpt-5.4"],
        apiKey: "fallback-key",
        auth: { type: "oauth" },
      },
    },
  }, []);

  const result = await resolveRuntimeAuth({
    providerName: "openai",
    settings,
    credentials: {
      providers: {
        openai: {
          type: "oauth",
          access_token: "stale-token",
          refresh_token: "refresh-token",
          expires_at: "2000-01-01T00:00:00.000Z",
        },
      },
    },
    refreshOAuthToken: async () => ({
      type: "oauth",
      access_token: "fresh-token",
      refresh_token: "refresh-token",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  });

  assert.equal(result.state.bearerToken, "fresh-token");
  assert.equal(result.didRefresh, true);
});

test("clearProviderCredentials removes only the targeted provider entry", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "xbcode-auth-"));
  const credentialsPath = join(tempDir, "credentials.json");

  await writeCredentialsFile(credentialsPath, {
    providers: {
      openai: { type: "oauth", access_token: "a" },
      other: { type: "oauth", access_token: "b" },
    },
  });

  await clearProviderCredentials(credentialsPath, "openai");
  const saved = loadCredentialsFile(credentialsPath);
  assert.equal(saved.providers.openai, undefined);
  assert.equal(saved.providers.other?.access_token, "b");
});

test("updateProviderModels persists discovered model ids for one provider", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "xbcode-settings-"));
  const settingsPath = join(tempDir, "settings.json");

  await writeSettingsFile(settingsPath, normalizeSettings({
    providers: {
      openai: {
        models: ["old-model"],
        auth: { type: "oauth" },
      },
      other: {
        models: ["keep-me"],
      },
    },
    defaultProvider: "openai",
    defaultModel: "gpt-5",
  }, []));

  await updateProviderModels(settingsPath, "openai", ["gpt-5", "gpt-5-mini", "gpt-5"]);

  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(saved.providers.openai.models, ["gpt-5", "gpt-5-mini"]);
  assert.deepEqual(saved.providers.other.models, ["keep-me"]);
  assert.equal(saved.defaultProvider, "openai");
  assert.equal(saved.defaultModel, "gpt-5");
});

test("normalizeReasoningEffort accepts supported values and normalizes case/whitespace", () => {
  assert.equal(normalizeReasoningEffort("low"), "low");
  assert.equal(normalizeReasoningEffort("HIGH"), "high");
  assert.equal(normalizeReasoningEffort(" minimal "), "minimal");
  assert.equal(normalizeReasoningEffort("xhigh"), "xhigh");
  assert.equal(normalizeReasoningEffort("max"), "max");
  assert.equal(normalizeReasoningEffort("none"), undefined);
  assert.equal(normalizeReasoningEffort("ultra"), undefined);
  assert.equal(normalizeReasoningEffort(undefined), undefined);
  assert.equal(normalizeReasoningEffort(3), undefined);
});

test("normalizeSettings keeps valid reasoningEffort and warns on invalid values", () => {
  const warnings: string[] = [];
  const settings = normalizeSettings({ providers: {}, reasoningEffort: "high" }, warnings);
  assert.equal(settings.reasoningEffort, "high");
  assert.equal(warnings.length, 0);

  const invalidWarnings: string[] = [];
  const invalid = normalizeSettings({ providers: {}, reasoningEffort: "ultra" }, invalidWarnings);
  assert.equal(invalid.reasoningEffort, undefined);
  assert.equal(invalidWarnings.length, 1);
  assert.match(invalidWarnings[0] ?? "", /reasoningEffort/);
});

test("normalizeSettings keeps defaultModel when provided", () => {
  const settings = normalizeSettings({
    providers: {
      openai: {
        models: ["gpt-5", "gpt-5-mini"],
      },
    },
    defaultProvider: "openai",
    defaultModel: "gpt-5-mini",
  }, []);

  assert.equal(settings.defaultProvider, "openai");
  assert.equal(settings.defaultModel, "gpt-5-mini");
});

test("shouldPromptForModelSelection skips picker when MODEL_ID is set for the session", () => {
  assert.equal(shouldPromptForModelSelection({
    providerName: "openai",
    model: "gpt-4.1",
    availableModels: [],
  }, true), false);
});

test("shouldPromptForModelSelection still prompts for broken saved defaults without env override", () => {
  assert.equal(shouldPromptForModelSelection({
    providerName: "openai",
    model: "gpt-4.1",
    availableModels: ["gpt-5", "gpt-5-mini"],
  }), true);
});

test("needsModelSelection is exported for startup callers", () => {
  assert.equal(typeof needsModelSelection, "function");
});
