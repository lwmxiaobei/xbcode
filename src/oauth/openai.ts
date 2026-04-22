import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";

import type { StoredOAuthCredentials } from "../config.js";

export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_OAUTH_USER_AGENT = "codex-cli/0.91.0";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex/";
export const OPENAI_CODEX_USER_AGENT = "codex_cli_rs/0.104.0";
export const OPENAI_CODEX_ORIGINATOR = "codex_cli_rs";
export const OPENAI_CODEX_VERSION = "0.104.0";
// Keep the default redirect URI aligned with the Codex/OpenAI OAuth client.
// Why this matters:
// - OAuth providers compare redirect URIs as exact strings rather than "same host".
// - `localhost` and `127.0.0.1` are equivalent for local networking, but they are
//   different redirect URIs from the OAuth server's perspective.
// - `sub2api` and the upstream Codex-oriented flow both use `localhost`, so we
//   mirror that value here to avoid authorization-page rejections before the
//   browser ever reaches our local callback server.
export const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OPENAI_OAUTH_SCOPES = "openid profile email offline_access";
export const OPENAI_REFRESH_SCOPES = "openid profile email";

export type OpenAITokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

export type OpenAIModelObject = {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
};

export type OpenAIModelsResponse = {
  object?: string;
  data?: OpenAIModelObject[];
};

type OpenAIAuthClaims = {
  chatgpt_account_id?: string;
};

type OpenAIJWTClaims = {
  ["https://api.openai.com/auth"]?: OpenAIAuthClaims;
};

export type BuildAuthorizationUrlArgs = {
  clientId?: string;
  redirectUri?: string;
  state: string;
  codeChallenge: string;
};

export type CallbackServerOptions = {
  hostname: string;
  port: number;
  path: string;
  timeoutMs: number;
};

export type OAuthCallbackResult = {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

/**
 * Normalize short callback values before validating them.
 *
 * Why this exists:
 * - Query parameters are expected to be plain strings, but trimming keeps the
 *   comparison resilient to accidental whitespace when values pass through
 *   terminal copy/paste or middleware layers.
 * - Returning `undefined` for empty strings keeps downstream checks simple and
 *   makes mismatch diagnostics clearer.
 */
function normalizeCallbackValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Decode a JWT payload without verifying its signature.
 *
 * Why this exists:
 * - The OAuth tokens already come from OpenAI; we only need non-sensitive routing
 *   metadata such as `chatgpt_account_id` to address the ChatGPT Codex backend.
 * - Local decoding avoids additional network requests and keeps login follow-up
 *   work synchronous with the token exchange response.
 * - Returning `undefined` on parse failure lets callers fall back gracefully.
 */
function decodeOpenAIJWTClaims(token: string | undefined): OpenAIJWTClaims | undefined {
  const normalized = token?.trim();
  if (!normalized) {
    return undefined;
  }

  const parts = normalized.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = parts[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json) as OpenAIJWTClaims;
  } catch {
    return undefined;
  }
}

/**
 * Extract the ChatGPT account id carried inside OpenAI OAuth JWTs.
 *
 * Why this exists:
 * - ChatGPT's Codex backend expects `chatgpt-account-id` on OAuth requests.
 * - The account id is present in both access tokens and id tokens, so we can
 *   derive it locally without additional API calls.
 * - Access token metadata is checked first because it is the credential used for
 *   actual model requests and is less likely to drift from the active session.
 */
function extractChatGPTAccountID(token: string | undefined): string | undefined {
  return decodeOpenAIJWTClaims(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() || undefined;
}

export type StartOpenAILoginArgs = {
  hostname?: string;
  port?: number;
  path?: string;
  timeoutMs?: number;
  state?: string;
  codeVerifier?: string;
  clientId?: string;
  openUrl?: (url: string) => Promise<void> | void;
  waitForCallback?: (options: CallbackServerOptions) => Promise<OAuthCallbackResult>;
  exchangeCode?: (args: {
    clientId: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }) => Promise<OpenAITokenResponse>;
};

export type StartOpenAILoginResult = {
  authorizationUrl: string;
  credentials: StoredOAuthCredentials;
};

let oauthProxyDispatcher: Dispatcher | null = null;
type OAuthFetchInit = RequestInit & { dispatcher?: Dispatcher };
type OpenAIOAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Detect whether the current process has proxy environment variables that
 * should be applied to outbound OAuth HTTP requests.
 *
 * Why this exists:
 * - Node's built-in `fetch` behavior around shell proxy variables is not
 *   consistent enough for this CLI's OAuth flow.
 * - The user already configures proxies in their shell environment, so the CLI
 *   should honor those settings explicitly instead of hoping the runtime does.
 * - Returning a boolean keeps the call site simple and avoids constructing a
 *   proxy dispatcher when there is nothing to route through.
 */
function hasProxyEnvironment(): boolean {
  return [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ].some((value) => Boolean(value?.trim()));
}

/**
 * Create a shared dispatcher that makes OAuth HTTP requests follow the same
 * proxy environment variables as the user's shell.
 *
 * Why this exists:
 * - `/oauth/token` is the first request in this flow that is performed by the
 *   local Node process instead of the browser, so it must opt into proxy usage
 *   explicitly.
 * - `EnvHttpProxyAgent` understands the conventional proxy variables and `NO_PROXY`,
 *   which is the least surprising behavior for a CLI running from a terminal.
 * - The dispatcher is cached so repeated refresh-token calls do not recreate
 *   connection pools unnecessarily.
 */
function getOAuthDispatcher(): Dispatcher | undefined {
  if (!hasProxyEnvironment()) {
    return undefined;
  }

  if (!oauthProxyDispatcher) {
    oauthProxyDispatcher = new EnvHttpProxyAgent();
  }

  return oauthProxyDispatcher;
}

/**
 * Create a fetch implementation for OpenAI OAuth traffic that explicitly uses
 * the shell proxy environment when present.
 *
 * Why this exists:
 * - The OpenAI SDK accepts a custom fetch function, which is the narrowest hook
 *   we need to make runtime model calls behave like the OAuth token exchange.
 * - Reusing the same dispatcher logic keeps proxy behavior consistent across
 *   login, refresh, and model inference requests.
 * - The wrapper stays generic so the SDK can keep managing retries, streaming,
 *   and abort signals on top of it.
 */
export function createOpenAIOAuthFetch(): OpenAIOAuthFetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit: OAuthFetchInit = {
      ...init,
      dispatcher: getOAuthDispatcher(),
    };
    return await fetch(input, requestInit);
  };
}

/**
 * Build the default headers required for ChatGPT Codex backend requests.
 *
 * Why this exists:
 * - OpenAI OAuth tokens used by Codex are accepted by ChatGPT's internal Codex
 *   endpoint rather than the public OpenAI Responses API.
 * - These headers mirror the minimum set `sub2api` forwards for OAuth accounts:
 *   a Codex client user agent, `originator`, the experimental responses flag,
 *   and the active ChatGPT account id.
 * - Returning a plain object lets the OpenAI SDK merge them with request-level
 *   headers without any additional client subclassing.
 */
export function getOpenAIOAuthDefaultHeaders(credentials: StoredOAuthCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    "OpenAI-Beta": "responses=experimental",
    Version: OPENAI_CODEX_VERSION,
    originator: OPENAI_CODEX_ORIGINATOR,
    "user-agent": OPENAI_CODEX_USER_AGENT,
  };

  const chatgptAccountID = credentials.chatgpt_account_id?.trim();
  if (chatgptAccountID) {
    headers["chatgpt-account-id"] = chatgptAccountID;
  }

  return headers;
}

function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

export function generateRandomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function generateCodeVerifier(): string {
  return generateRandomHex(64);
}

export function generateCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizationUrl({
  clientId = OPENAI_OAUTH_CLIENT_ID,
  redirectUri = OPENAI_REDIRECT_URI,
  state,
  codeChallenge,
}: BuildAuthorizationUrlArgs): string {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OPENAI_OAUTH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  return url.toString();
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const requestInit: OAuthFetchInit = {
    method: "POST",
    dispatcher: getOAuthDispatcher(),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": OPENAI_OAUTH_USER_AGENT,
    },
    body,
  };
  const response = await fetch(url, requestInit);

  if (!response.ok) {
    const responseBody = (await response.text()).trim();
    const detail = responseBody ? `: ${responseBody}` : "";
    throw new Error(`OAuth request failed with status ${response.status}${detail}`);
  }

  return await response.json() as T;
}

/**
 * Fetch the model IDs visible to the current OpenAI bearer token.
 *
 * Why this exists:
 * - After OAuth login succeeds, the CLI can immediately discover the models the
 *   authenticated account can use instead of relying on a stale static list.
 * - Using the same dispatcher and User-Agent policy as the token exchange keeps
 *   network behavior consistent across proxy and region-sensitive environments.
 * - Returning a sorted, de-duplicated string list gives callers a stable value
 *   that can be written directly into configuration.
 */
export async function listAvailableModels({
  accessToken,
  baseURL = "https://api.openai.com/v1",
}: {
  accessToken: string;
  baseURL?: string;
}): Promise<string[]> {
  const normalizedBaseURL = baseURL.endsWith("/") ? baseURL : `${baseURL}/`;
  const modelsUrl = new URL("models", normalizedBaseURL).toString();
  const requestInit: OAuthFetchInit = {
    method: "GET",
    dispatcher: getOAuthDispatcher(),
    headers: {
      authorization: `Bearer ${accessToken}`,
      "user-agent": OPENAI_OAUTH_USER_AGENT,
    },
  };
  const response = await fetch(modelsUrl, requestInit);

  if (!response.ok) {
    const responseBody = (await response.text()).trim();
    const detail = responseBody ? `: ${responseBody}` : "";
    throw new Error(`OpenAI models request failed with status ${response.status}${detail}`);
  }

  const payload = await response.json() as OpenAIModelsResponse;
  return (payload.data ?? [])
    .map((model) => model.id?.trim() ?? "")
    .filter((modelId, index, values) => Boolean(modelId) && values.indexOf(modelId) === index)
    .sort((left, right) => left.localeCompare(right));
}

export async function exchangeCodeForToken({
  clientId = OPENAI_OAUTH_CLIENT_ID,
  redirectUri = OPENAI_REDIRECT_URI,
  code,
  codeVerifier,
}: {
  clientId?: string;
  redirectUri?: string;
  code: string;
  codeVerifier: string;
}): Promise<OpenAITokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  return await postForm<OpenAITokenResponse>(OPENAI_TOKEN_URL, body);
}

export async function refreshAccessToken({
  clientId = OPENAI_OAUTH_CLIENT_ID,
  refreshToken,
}: {
  clientId?: string;
  refreshToken: string;
}): Promise<StoredOAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    scope: OPENAI_REFRESH_SCOPES,
  });
  const token = await postForm<OpenAITokenResponse>(OPENAI_TOKEN_URL, body);
  return tokenResponseToCredentials(token, clientId);
}

export function tokenResponseToCredentials(
  token: OpenAITokenResponse,
  clientId = OPENAI_OAUTH_CLIENT_ID,
): StoredOAuthCredentials {
  const expiresAt = typeof token.expires_in === "number"
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : undefined;
  const chatgptAccountID = extractChatGPTAccountID(token.access_token) || extractChatGPTAccountID(token.id_token);

  return {
    type: "oauth",
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    id_token: token.id_token,
    expires_at: expiresAt,
    client_id: clientId,
    chatgpt_account_id: chatgptAccountID,
  };
}

export async function waitForOAuthCallback(options: CallbackServerOptions): Promise<OAuthCallbackResult> {
  return await new Promise<OAuthCallbackResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close(() => reject(new Error("OAuth callback timed out")));
    }, options.timeoutMs);

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${options.hostname}:${options.port}`);
      if (request.method !== "GET" || url.pathname !== options.path) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      const result: OAuthCallbackResult = {
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
        errorDescription: url.searchParams.get("error_description") ?? undefined,
      };

      response.statusCode = result.error ? 400 : 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(result.error
        ? "<html><body><h1>OpenAI OAuth failed</h1><p>Return to the terminal.</p></body></html>"
        : "<html><body><h1>OpenAI OAuth completed</h1><p>You can return to the terminal.</p></body></html>");

      clearTimeout(timer);
      server.close(() => resolve(result));
    });

    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    server.listen(options.port, options.hostname);
  });
}

export async function startOpenAILogin({
  // Use `localhost` by default so the generated redirect URI matches the
  // registered OAuth client configuration used by the OpenAI/Codex flow.
  hostname = "localhost",
  port = 1455,
  path = "/auth/callback",
  // Give the browser login flow enough time for proxy hops, manual account
  // selection, and multi-factor prompts without forcing the user to restart.
  timeoutMs = 300_000,
  state = generateRandomHex(32),
  codeVerifier = generateCodeVerifier(),
  clientId = OPENAI_OAUTH_CLIENT_ID,
  openUrl,
  waitForCallback = waitForOAuthCallback,
  exchangeCode = exchangeCodeForToken,
}: StartOpenAILoginArgs = {}): Promise<StartOpenAILoginResult> {
  const redirectUri = `http://${hostname}:${port}${path}`;
  const authorizationUrl = buildAuthorizationUrl({
    clientId,
    redirectUri,
    state,
    codeChallenge: generateCodeChallenge(codeVerifier),
  });

  await openUrl?.(authorizationUrl);

  const callback = await waitForCallback({
    hostname,
    port,
    path,
    timeoutMs,
  });

  const callbackError = normalizeCallbackValue(callback.error);
  const callbackCode = normalizeCallbackValue(callback.code);
  const callbackState = normalizeCallbackValue(callback.state);
  const expectedState = normalizeCallbackValue(state);

  if (callbackError) {
    throw new Error(normalizeCallbackValue(callback.errorDescription) ?? callbackError);
  }
  if (!callbackCode) {
    throw new Error("OAuth callback did not include a code");
  }
  if (callbackState !== expectedState) {
    throw new Error(`OAuth state mismatch (expected=${expectedState ?? "(missing)"} got=${callbackState ?? "(missing)"})`);
  }

  const token = await exchangeCode({
    clientId,
    redirectUri,
    code: callbackCode,
    codeVerifier,
  });

  return {
    authorizationUrl,
    credentials: tokenResponseToCredentials(token, clientId),
  };
}
