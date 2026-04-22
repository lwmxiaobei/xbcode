# OpenAI OAuth Design For `code-agent`

Date: 2026-04-21

## Goal

Add optional OpenAI ChatGPT OAuth login to `code-agent` while fully preserving the existing `apiKey` provider workflow.

This change must:

- Keep current `apiKey`-based OpenAI usage working without migration.
- Allow an `openai` provider to authenticate with OAuth and directly use the OAuth `access_token` as the bearer token for OpenAI API requests.
- Refresh expired OAuth tokens automatically when a valid `refresh_token` exists.
- Fall back to the configured `apiKey` when OAuth credentials are unavailable or refresh fails.
- Minimize changes to the existing CLI architecture.

This change must not:

- Replace the existing `apiKey` flow.
- Introduce a generic multi-provider auth framework.
- Depend on generating API keys after OAuth login.
- Refactor the agent loop or provider system beyond what is needed for the OpenAI OAuth path.

## Background

`sub2api` already implements OpenAI OAuth with Authorization Code + PKCE. Its relevant properties are:

- Authorization endpoint: `https://auth.openai.com/oauth/authorize`
- Token endpoint: `https://auth.openai.com/oauth/token`
- Flow type: Authorization Code + PKCE
- Redirect URI pattern: localhost callback
- Scopes: `openid profile email offline_access`
- Returned credentials: `access_token`, `refresh_token`, `id_token`, `expires_in`

`code-agent` currently only supports static provider credentials from `~/.xbcode/settings.json`, primarily `apiKey`, `baseURL`, and `apiMode`.

The smallest safe implementation is to add an OpenAI-specific OAuth credential layer on top of the existing provider configuration, rather than redesigning all provider authentication.

## Chosen Approach

Implement an OpenAI-only OAuth subsystem with separate credential persistence.

At runtime:

1. Read static provider config from `~/.xbcode/settings.json`.
2. Read dynamic OAuth credentials from `~/.xbcode/credentials.json`.
3. For the active OpenAI provider:
   - If OAuth is enabled and a valid `access_token` exists, use it.
   - If the token is expired and a `refresh_token` exists, refresh it and persist the new credentials.
   - If OAuth is unavailable or refresh fails, fall back to `apiKey`.
4. Create the OpenAI client with the resolved bearer token.

This keeps the current `index.tsx -> resolveConfig() -> createAgentConfig()` shape intact while adding a narrow, explicit auth resolution step.

## Alternatives Considered

### Option A: OpenAI-only OAuth layer

This is the selected option.

Pros:

- Minimal change surface
- Matches the current `sub2api` implementation model
- Keeps `apiKey` fallback simple
- Does not require redesigning provider config

Cons:

- Authentication logic is not generalized for other providers

### Option B: Generic provider auth framework

Pros:

- Cleaner long-term abstraction
- Easier to extend to other OAuth providers later

Cons:

- Larger config and runtime refactor
- Higher implementation and regression risk
- Not needed for the current requirement

### Option C: OAuth login that later creates an API key

Pros:

- Runtime would continue using the existing API key model

Cons:

- Not aligned with the selected requirement
- Depends on an additional API-key-generation workflow that is not part of the current validated design
- Harder to verify safely

## User-Facing Design

### Configuration

The existing settings file remains valid.

`~/.xbcode/settings.json` gains an optional auth section for a provider:

```json
{
  "providers": {
    "openai": {
      "models": ["gpt-5.4", "gpt-5.4-mini"],
      "apiKey": "OPTIONAL_FALLBACK_KEY",
      "baseURL": "https://api.openai.com/v1",
      "apiMode": "responses",
      "auth": {
        "type": "oauth"
      }
    }
  },
  "defaultProvider": "openai"
}
```

Rules:

- `auth` is optional.
- If `auth.type !== "oauth"`, provider behavior is unchanged.
- `apiKey` remains optional when OAuth is enabled, but strongly recommended as a fallback in this first version.

### Credential Persistence

OAuth credentials live in a separate file:

- Path: `~/.xbcode/credentials.json`

Reason:

- Token refresh should not rewrite `settings.json`.
- Static settings and dynamic credentials have different lifecycles.
- This keeps the provider configuration readable and stable.

Proposed shape:

```json
{
  "providers": {
    "openai": {
      "type": "oauth",
      "access_token": "...",
      "refresh_token": "...",
      "id_token": "...",
      "expires_at": "2026-04-21T12:34:56.000Z",
      "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
      "email": "user@example.com"
    }
  }
}
```

Rules:

- Credentials are keyed by provider name, matching `settings.json`.
- Only dynamic auth material belongs here.
- Missing or malformed `credentials.json` must not break normal `apiKey` usage.

### Slash Commands

Add:

- `/login`
- `/login <provider>`
- `/logout`
- `/logout <provider>`

Behavior:

- `/login` uses the current provider.
- `/login openai` explicitly logs in the named provider.
- `/logout` removes only OAuth credentials for the current provider.
- `/logout openai` removes OAuth credentials for that provider.
- Neither command edits the static provider model list or `baseURL`.

### Status Output

`/status` should show a short auth summary:

- `auth oauth(user@example.com, expires in 23m)`
- `auth oauth(expired, apiKey fallback available)`
- `auth apiKey`
- `auth none`

This keeps auth state visible without dumping secrets.

## OAuth Flow Design

### Flow Summary

1. User runs `/login openai` or `/login` while the current provider is `openai`.
2. CLI generates:
   - `state`
   - `code_verifier`
   - `code_challenge`
3. CLI starts a temporary localhost callback server.
4. CLI builds the authorization URL and prints it.
5. If possible, CLI may also try to open the system browser, but manual opening is always supported.
6. Browser completes consent and redirects to localhost callback with `code` and `state`.
7. CLI validates `state`.
8. CLI exchanges `code + code_verifier` for tokens.
9. CLI persists credentials to `credentials.json`.
10. CLI reports success and the linked provider/email.

### Endpoints And Parameters

Authorization URL:

- Base: `https://auth.openai.com/oauth/authorize`
- Required params:
  - `response_type=code`
  - `client_id=<OpenAI client id>`
  - `redirect_uri=http://127.0.0.1:1455/auth/callback`
  - `scope=openid profile email offline_access`
  - `state=<random>`
  - `code_challenge=<pkce challenge>`
  - `code_challenge_method=S256`
  - `id_token_add_organizations=true`
  - `codex_cli_simplified_flow=true`

Token exchange:

- URL: `https://auth.openai.com/oauth/token`
- Form fields:
  - `grant_type=authorization_code`
  - `client_id=<OpenAI client id>`
  - `code=<callback code>`
  - `redirect_uri=http://127.0.0.1:1455/auth/callback`
  - `code_verifier=<pkce verifier>`

Token refresh:

- URL: `https://auth.openai.com/oauth/token`
- Form fields:
  - `grant_type=refresh_token`
  - `client_id=<OpenAI client id>`
  - `refresh_token=<stored refresh token>`
  - `scope=openid profile email`

### Local Callback Server

The callback server:

- Binds only during the login attempt
- Listens on `127.0.0.1:1455`
- Handles `GET /auth/callback`
- Stops immediately after success, error, or timeout

The callback response page can be very small:

- Success message
- “You can return to the terminal”
- No token data rendered in the browser

The browser page is only a transport completion page, not a full UI flow.

### Session State

During login, the CLI keeps an in-memory session object containing:

- provider name
- `state`
- `code_verifier`
- `redirect_uri`
- start time

This state is not persisted to disk because it is only needed for the in-flight authorization attempt.

## Runtime Auth Resolution

### Resolution Order

For the current provider:

1. Load static provider config.
2. If provider auth is not `oauth`, use `apiKey`.
3. If provider auth is `oauth`:
   - Load stored OAuth credentials.
   - If `access_token` exists and is not expired, use it.
   - If expired and `refresh_token` exists, try refresh.
   - If refresh succeeds, persist new credentials and use refreshed `access_token`.
   - If refresh fails and `apiKey` exists, use `apiKey`.
   - If refresh fails and no `apiKey` exists, return an explicit auth error before starting the model request.

### Expiry Behavior

Use `expires_at` as the primary persisted expiry field.

Refresh should happen before the exact expiry time with a small skew window to avoid racing requests against token expiration.

Recommended initial skew:

- 60 seconds

This keeps the implementation simple while avoiding near-expiry failures.

### Client Construction

The OpenAI client creation remains structurally unchanged except for the resolved credential source.

Instead of directly using `resolved.apiKey`, the runtime uses the final resolved bearer token:

- OAuth `access_token` if available and valid
- otherwise `apiKey`

No other request-shape changes are required in this phase.

## Error Handling

### Login Errors

- Callback port unavailable:
  - Fail login clearly
  - Do not modify credentials
  - Tell the user that port `1455` is unavailable

- Browser could not be opened:
  - Print the authorization URL
  - Continue waiting for manual browser completion

- Callback includes `error`:
  - Fail login
  - Do not modify credentials

- Returned `state` does not match:
  - Fail login
  - Do not modify credentials

- Token exchange fails:
  - Fail login
  - Do not modify credentials

### Runtime Errors

- Credentials file missing:
  - Treat as no OAuth credentials
  - Continue with `apiKey` if present

- Credentials file malformed:
  - Warn in status/log output
  - Treat as no OAuth credentials
  - Continue with `apiKey` if present

- Token refresh fails:
  - Preserve previous credentials on disk unless a safe partial update is explicitly intended
  - Fall back to `apiKey` if present
  - Otherwise return an actionable auth error

- Access token missing:
  - Fall back to `apiKey`
  - Otherwise return an auth error

### Security And Logging Rules

- Never print raw `access_token`, `refresh_token`, or `id_token`
- Never include tokens in `/status`
- Never write partial credentials after a failed exchange
- File writes should replace the credentials atomically from the process perspective

## File-Level Design

### Existing Files To Update

#### `src/config.ts`

Responsibilities to add:

- parse provider `auth` config
- load `credentials.json`
- normalize credential records
- resolve final auth state for a provider
- provide a write helper for OAuth credential persistence

This file remains the source of truth for configuration loading, but dynamic credential logic should stay small and focused.

#### `src/index.tsx`

Responsibilities to add:

- register `/login` and `/logout`
- surface auth state in `/status`
- use resolved OAuth-or-apiKey bearer token when creating the client

This is also the most natural place to invoke the login flow because slash commands are already handled here.

#### `README.md` and `README.zh-CN.md`

Documentation to add:

- example `auth` config
- credential file behavior
- `/login` and `/logout` usage
- fallback behavior with `apiKey`

### New Files

#### `src/oauth/openai.ts`

Responsibilities:

- generate PKCE verifier and challenge
- build authorization URL
- run temporary callback server
- exchange code for token
- refresh token

This file should stay OpenAI-specific and not pretend to be a provider-agnostic auth framework.

#### `src/oauth/types.ts`

Responsibilities:

- OAuth credential types
- OAuth login result types
- OpenAI token response types

If the type footprint stays small, these may also live in `config.ts`, but a dedicated type file is preferable if it improves readability.

## Testing Design

This feature changes auth behavior, so coverage must focus on resolution order and failure paths.

### Unit Tests

#### Config/Auth Resolution

Test cases:

- provider without `auth` uses `apiKey`
- provider with `auth.type = oauth` uses valid OAuth token
- expired OAuth token triggers refresh
- refresh failure falls back to `apiKey`
- refresh failure without `apiKey` returns auth error
- malformed credentials file is ignored safely

#### OAuth Helper

Test cases:

- PKCE verifier generation shape
- code challenge generation
- auth URL includes required query params
- token exchange response parsing
- refresh response parsing

### Integration-Style Tests

Using stub HTTP servers:

- successful callback flow persists credentials
- invalid state rejects callback
- callback with OAuth error rejects login
- refresh updates stored credentials

### CLI-Level Tests

At minimum:

- `/login` resolves the target provider correctly
- `/logout` removes provider OAuth credentials only
- `/status` renders auth summary without leaking secrets

## Out Of Scope

The following are intentionally excluded from this design:

- OAuth for non-OpenAI providers
- generating API keys after OAuth login
- multiple localhost port fallback selection
- background token refresh daemons
- encrypted local credential storage
- browser-based rich login UI
- provider auth abstraction redesign

## Rollout Notes

This feature is safe to ship incrementally because the legacy `apiKey` path remains intact.

Recommended implementation order:

1. credential types and config loading
2. OAuth helper module
3. runtime auth resolution
4. `/login` and `/logout`
5. `/status` auth summary
6. tests
7. docs

## Spec Self-Review

This spec was checked for:

- placeholders: none remain
- contradictions: none found between runtime flow and CLI flow
- scope creep: generic provider auth was explicitly excluded
- ambiguity: token source precedence is explicitly defined as OAuth first, then `apiKey`

## Approval Gate

Before implementation starts, the user should review this spec and confirm whether the file accurately captures the intended first version of OpenAI OAuth support.
