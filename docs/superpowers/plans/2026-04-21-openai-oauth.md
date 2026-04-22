# OpenAI OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional OpenAI ChatGPT OAuth login to `code-agent` while preserving the existing `apiKey` flow and using OAuth `access_token` directly when available.

**Architecture:** Keep static provider config in `src/config.ts`, add separate credential persistence in `~/.xbcode/credentials.json`, and introduce a narrow `src/oauth/openai.ts` helper for PKCE, callback handling, token exchange, and refresh. Runtime auth resolution stays provider-local: use valid OAuth token first, otherwise fall back to `apiKey`.

**Tech Stack:** TypeScript, Node.js built-ins (`http`, `crypto`, `fs`, `path`, `os`), OpenAI SDK, Node test runner with `tsx`

---

### Task 1: Add Auth And Credential Types To Config

**Files:**
- Modify: `src/config.ts`
- Test: `test/config-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSettings,
  resolveProviderAuthState,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config-auth.test.ts`
Expected: FAIL with missing exports or missing auth handling in `src/config.ts`

- [ ] **Step 3: Write minimal implementation**

```ts
export type ProviderAuthConfig = {
  type: "oauth";
};

export type StoredOAuthCredentials = {
  type: "oauth";
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: string;
  client_id?: string;
  email?: string;
};

export type CredentialsFile = {
  providers: Record<string, StoredOAuthCredentials>;
};

export type ProviderAuthState = {
  authMode: "oauth" | "apiKey" | "none";
  bearerToken: string;
  apiKey: string;
  oauth?: StoredOAuthCredentials;
};

export function normalizeSettings(...) { ...auth parsing... }
export function resolveProviderAuthState(...) { ...oauth first, then apiKey... }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/config-auth.test.ts src/config.ts
git commit -m "feat: add auth state resolution"
```

### Task 2: Add Credential File Loading And Persistence

**Files:**
- Modify: `src/config.ts`
- Test: `test/config-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config-auth.test.ts`
Expected: FAIL because credential read/write helpers do not exist

- [ ] **Step 3: Write minimal implementation**

```ts
export function getCredentialsPath(): string {
  return CREDENTIALS_PATH;
}

export function loadCredentialsFile(filePath = CREDENTIALS_PATH): CredentialsFile {
  ...
}

export async function writeCredentialsFile(filePath: string, credentials: CredentialsFile): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(credentials, null, 2)}\n`, "utf8");
}

export async function clearProviderCredentials(filePath: string, providerName: string): Promise<void> {
  ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/config-auth.test.ts src/config.ts
git commit -m "feat: add oauth credential persistence"
```

### Task 3: Add OpenAI OAuth Helper

**Files:**
- Create: `src/oauth/openai.ts`
- Test: `test/openai-oauth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";

import { buildAuthorizationUrl, generateCodeChallenge } from "../src/oauth/openai.js";

test("buildAuthorizationUrl includes pkce and codex params", () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: "client",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    state: "state-1",
    codeChallenge: generateCodeChallenge("verifier"),
  }));

  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/openai-oauth.test.ts`
Expected: FAIL because `src/oauth/openai.ts` does not exist

- [ ] **Step 3: Write minimal implementation**

```ts
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";

export function generateRandomHex(bytes: number): string { ... }
export function generateCodeVerifier(): string { ... }
export function generateCodeChallenge(verifier: string): string { ... }
export function buildAuthorizationUrl(args: ...): string { ... }
export async function exchangeCodeForToken(args: ...): Promise<OpenAITokenResponse> { ... }
export async function refreshAccessToken(args: ...): Promise<OpenAITokenResponse> { ... }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/openai-oauth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/openai-oauth.test.ts src/oauth/openai.ts
git commit -m "feat: add openai oauth helper"
```

### Task 4: Add Callback Server Flow

**Files:**
- Modify: `src/oauth/openai.ts`
- Test: `test/openai-oauth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("waitForOAuthCallback resolves code and state from callback request", async () => {
  const callback = waitForOAuthCallback({ hostname: "127.0.0.1", port: 1455, path: "/auth/callback", timeoutMs: 1_000 });
  const response = await fetch("http://127.0.0.1:1455/auth/callback?code=abc&state=xyz");
  assert.equal(response.status, 200);
  const result = await callback;
  assert.equal(result.code, "abc");
  assert.equal(result.state, "xyz");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/openai-oauth.test.ts`
Expected: FAIL because callback server helper does not exist

- [ ] **Step 3: Write minimal implementation**

```ts
export async function waitForOAuthCallback(options: CallbackServerOptions): Promise<OAuthCallbackResult> {
  return await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "", `http://${options.hostname}:${options.port}`);
      ...
      resolve({ code, state, error, errorDescription });
      server.close();
    });
    server.listen(options.port, options.hostname);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/openai-oauth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/openai-oauth.test.ts src/oauth/openai.ts
git commit -m "feat: add oauth callback server"
```

### Task 5: Wire Runtime Auth Resolution Into Client Creation

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.tsx`
- Test: `test/config-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("resolveRuntimeAuth refreshes expired oauth token before falling back to apiKey", async () => {
  const result = await resolveRuntimeAuth({
    providerName: "openai",
    settings,
    credentials,
    refreshOAuthToken: async () => ({
      type: "oauth",
      access_token: "fresh-token",
      refresh_token: "refresh-token",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
  });

  assert.equal(result.bearerToken, "fresh-token");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config-auth.test.ts`
Expected: FAIL because runtime auth resolution does not support refresh

- [ ] **Step 3: Write minimal implementation**

```ts
export async function resolveRuntimeAuth(args: ResolveRuntimeAuthArgs): Promise<ProviderAuthState> {
  const state = resolveProviderAuthState(...);
  if (state.authMode !== "oauth") {
    return state;
  }
  if (!isExpired(state.oauth?.expires_at)) {
    return state;
  }
  ...
}
```

And in `src/index.tsx`:

```ts
async function ensureConfig(providerName?: string, modelName?: string): Promise<void> {
  currentResolved = resolveConfig(providerName, modelName);
  const authState = await resolveRuntimeAuth(...);
  agentConfig = createAgentConfig(currentResolved, authState.bearerToken);
  primeMcpRuntime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/config-auth.test.ts src/config.ts src/index.tsx
git commit -m "feat: wire runtime oauth resolution"
```

### Task 6: Add Login And Logout Slash Commands

**Files:**
- Modify: `src/index.tsx`
- Modify: `src/config.ts`
- Modify: `src/oauth/openai.ts`
- Test: `test/config-auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/config-auth.test.ts`
Expected: FAIL because provider credential clearing is incomplete or missing

- [ ] **Step 3: Write minimal implementation**

```ts
if (command.startsWith("login")) {
  const providerArg = command.slice(5).trim() || currentResolved.providerName;
  ...
  const flow = await loginWithOpenAI({
    providerName: providerArg,
    onUrl: (url) => pushMessage("system", `Open this URL to continue login:\n${url}`, "login"),
  });
  pushMessage("system", `Logged in to ${providerArg}${flow.email ? ` as ${flow.email}` : ""}`, "login");
  await ensureConfig(providerArg, currentResolved.model);
  return;
}

if (command.startsWith("logout")) {
  ...
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/config-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/config-auth.test.ts src/config.ts src/oauth/openai.ts src/index.tsx
git commit -m "feat: add oauth login commands"
```

### Task 7: Add Status Output And Documentation

**Files:**
- Modify: `src/index.tsx`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Write the failing test**

No automated test is required for README updates, but add a config-level assertion for auth summary input shape if needed before editing runtime output.

- [ ] **Step 2: Run test to verify current behavior is insufficient**

Run: `npm test -- test/config-auth.test.ts`
Expected: Existing tests do not cover auth summary yet

- [ ] **Step 3: Write minimal implementation**

In `src/index.tsx`, extend `/status`:

```ts
const authLine = currentAuthSummary ?? "auth none";
return [
  ...
  authLine,
  ...
].join("\\n");
```

In docs, add:

```md
"auth": {
  "type": "oauth"
}
```

and usage:

```bash
/login openai
/logout openai
```

- [ ] **Step 4: Run test to verify nothing regressed**

Run: `npm test -- test/config-auth.test.ts test/openai-oauth.test.ts test/prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.tsx README.md README.zh-CN.md
git commit -m "docs: document openai oauth login"
```

### Task 8: Final Verification

**Files:**
- Modify: none unless verification uncovers issues
- Test: `test/config-auth.test.ts`, `test/openai-oauth.test.ts`

- [ ] **Step 1: Run targeted tests**

Run: `npm test -- test/config-auth.test.ts test/openai-oauth.test.ts`
Expected: PASS

- [ ] **Step 2: Run broader smoke tests**

Run: `npm test -- test/input-submit.test.ts test/prompt.test.ts test/skills-loader.test.ts test/skills-render.test.ts test/utils-debug-log.test.ts`
Expected: PASS

- [ ] **Step 3: Run build verification**

Run: `npm run build`
Expected: TypeScript build succeeds with no errors

- [ ] **Step 4: Review git diff**

Run: `git status --short`
Expected: only intended OAuth-related files changed

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/index.tsx src/oauth/openai.ts test/config-auth.test.ts test/openai-oauth.test.ts README.md README.zh-CN.md docs/superpowers/specs/2026-04-21-openai-oauth-design.md docs/superpowers/plans/2026-04-21-openai-oauth.md
git commit -m "feat: add optional openai oauth login"
```

## Self-Review

- Spec coverage:
  - optional OAuth config: Task 1
  - separate credentials file: Task 2
  - OpenAI OAuth flow: Tasks 3 and 4
  - runtime token resolution and fallback: Task 5
  - login/logout commands: Task 6
  - status and docs: Task 7
  - verification: Task 8
- Placeholder scan: no TODO/TBD placeholders remain
- Type consistency: plan consistently uses `auth.type`, `credentials.json`, `resolveRuntimeAuth`, and provider-keyed credential storage
