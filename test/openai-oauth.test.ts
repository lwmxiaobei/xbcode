import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_ORIGINATOR,
  OPENAI_CODEX_USER_AGENT,
  OPENAI_CODEX_VERSION,
  OPENAI_OAUTH_USER_AGENT,
  buildAuthorizationUrl,
  createOpenAIOAuthFetch,
  generateCodeChallenge,
  exchangeCodeForToken,
  getOpenAIOAuthDefaultHeaders,
  listAvailableModels,
  startOpenAILogin,
  tokenResponseToCredentials,
} from "../src/oauth/openai.js";

function snapshotProxyEnv(): Record<string, string | undefined> {
  return {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    https_proxy: process.env.https_proxy,
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    ALL_PROXY: process.env.ALL_PROXY,
    all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
}

function restoreProxyEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearProxyEnv(): void {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]) {
    delete process.env[key];
  }
}

test("buildAuthorizationUrl includes pkce and codex params", () => {
  const url = new URL(buildAuthorizationUrl({
    clientId: "client",
    redirectUri: "http://localhost:1455/auth/callback",
    state: "state-1",
    codeChallenge: generateCodeChallenge("verifier"),
  }));

  assert.equal(url.origin, "https://auth.openai.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("state"), "state-1");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
});

test("tokenResponseToCredentials stores expires_at based on expires_in", () => {
  const accessToken = [
    "eyJhbGciOiJub25lIn0",
    Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-123",
      },
    })).toString("base64url"),
    "sig",
  ].join(".");
  const credentials = tokenResponseToCredentials({
    access_token: accessToken,
    refresh_token: "refresh",
    expires_in: 3600,
  }, "client");

  assert.equal(credentials.type, "oauth");
  assert.equal(credentials.access_token, accessToken);
  assert.equal(credentials.refresh_token, "refresh");
  assert.equal(credentials.client_id, "client");
  assert.equal(credentials.chatgpt_account_id, "acct-123");
  assert.ok(credentials.expires_at);
});

test("getOpenAIOAuthDefaultHeaders targets the codex backend contract", () => {
  const headers = getOpenAIOAuthDefaultHeaders({
    type: "oauth",
    access_token: "access",
    chatgpt_account_id: "acct-123",
  });

  assert.equal(OPENAI_CODEX_BASE_URL, "https://chatgpt.com/backend-api/codex/");
  assert.equal(headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(headers.Version, OPENAI_CODEX_VERSION);
  assert.equal(headers.originator, OPENAI_CODEX_ORIGINATOR);
  assert.equal(headers["user-agent"], OPENAI_CODEX_USER_AGENT);
  assert.equal(headers["chatgpt-account-id"], "acct-123");
});

test("startOpenAILogin exchanges callback code into stored credentials", async () => {
  const loginPromise = startOpenAILogin({
    timeoutMs: 2_000,
    state: "state-123",
    codeVerifier: "verifier-123",
    waitForCallback: async () => ({
      code: "code-123",
      state: "state-123",
    }),
    exchangeCode: async ({ code, codeVerifier }) => {
      assert.equal(code, "code-123");
      assert.equal(codeVerifier, "verifier-123");
      return {
        access_token: "access-123",
        refresh_token: "refresh-123",
        expires_in: 3600,
      };
    },
  });

  const result = await loginPromise;
  assert.equal(result.credentials.access_token, "access-123");
  assert.equal(result.credentials.refresh_token, "refresh-123");
});

test("startOpenAILogin rejects mismatched state", async () => {
  await assert.rejects(
    startOpenAILogin({
      state: "expected-state",
      codeVerifier: "verifier-123",
      waitForCallback: async () => ({
        code: "code-123",
        state: "different-state",
      }),
    }),
    /state mismatch/,
  );
});

test("exchangeCodeForToken sends codex user agent on token requests", async () => {
  const originalFetch = globalThis.fetch;
  const proxyEnv = snapshotProxyEnv();
  try {
    clearProxyEnv();
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://auth.openai.com/oauth/token");
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
      assert.equal(headers.get("user-agent"), OPENAI_OAUTH_USER_AGENT);
      assert.equal(init?.dispatcher, undefined);
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const token = await exchangeCodeForToken({
      clientId: "client",
      redirectUri: "http://localhost:1455/auth/callback",
      code: "code-123",
      codeVerifier: "verifier-123",
    });

    assert.equal(token.access_token, "access");
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(proxyEnv);
  }
});

test("exchangeCodeForToken uses a proxy dispatcher when proxy env is set", async () => {
  const originalFetch = globalThis.fetch;
  const proxyEnv = snapshotProxyEnv();
  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.dispatcher, "expected oauth token request to include proxy dispatcher");
      return new Response(JSON.stringify({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const token = await exchangeCodeForToken({
      clientId: "client",
      redirectUri: "http://localhost:1455/auth/callback",
      code: "code-123",
      codeVerifier: "verifier-123",
    });

    assert.equal(token.access_token, "access");
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(proxyEnv);
  }
});

test("exchangeCodeForToken includes response body in oauth errors", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{\"error\":\"forbidden\"}", {
      status: 403,
      headers: { "content-type": "application/json" },
    });

    await assert.rejects(
      exchangeCodeForToken({
        code: "code-123",
        codeVerifier: "verifier-123",
      }),
      /403: \{"error":"forbidden"\}/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createOpenAIOAuthFetch applies proxy dispatcher when proxy env is set", async () => {
  const originalFetch = globalThis.fetch;
  const proxyEnv = snapshotProxyEnv();
  try {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    const oauthFetch = createOpenAIOAuthFetch();
    globalThis.fetch = async (_input, init) => {
      assert.ok(init?.dispatcher);
      return new Response("ok", { status: 200 });
    };

    const response = await oauthFetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST" });
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(proxyEnv);
  }
});

test("listAvailableModels returns sorted unique model ids", async () => {
  const originalFetch = globalThis.fetch;
  const proxyEnv = snapshotProxyEnv();
  try {
    clearProxyEnv();
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://api.openai.com/v1/models");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer access-123");
      assert.equal(headers.get("user-agent"), OPENAI_OAUTH_USER_AGENT);
      return new Response(JSON.stringify({
        data: [
          { id: "gpt-5-mini" },
          { id: "gpt-5" },
          { id: "gpt-5-mini" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const models = await listAvailableModels({ accessToken: "access-123" });
    assert.deepEqual(models, ["gpt-5", "gpt-5-mini"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProxyEnv(proxyEnv);
  }
});
