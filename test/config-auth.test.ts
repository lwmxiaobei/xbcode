import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  clearProviderCredentials,
  loadCredentialsFile,
  normalizeSettings,
  resolveProviderAuthState,
  resolveRuntimeAuth,
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
  }, []));

  await updateProviderModels(settingsPath, "openai", ["gpt-5", "gpt-5-mini", "gpt-5"]);

  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(saved.providers.openai.models, ["gpt-5", "gpt-5-mini"]);
  assert.deepEqual(saved.providers.other.models, ["keep-me"]);
  assert.equal(saved.defaultProvider, "openai");
});
