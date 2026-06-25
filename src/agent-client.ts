import OpenAI from "openai";

import type { ProviderAuthState, ResolvedConfig, StoredOAuthCredentials } from "./config.js";
import { createSharedFetch } from "./http.js";
import {
  OPENAI_CODEX_BASE_URL,
  createOpenAIOAuthFetch,
  getOpenAIOAuthDefaultHeaders,
} from "./oauth/openai.js";

export type AgentClient = {
  client: OpenAI;
  // ChatGPT Codex backend rejects `previous_response_id`, so OAuth sessions
  // must replay statelessly. All other providers keep server-side chaining.
  supportsPreviousResponseId: boolean;
};

/**
 * Build the OpenAI client from a resolved provider config + auth state.
 *
 * Why this lives in its own module:
 * - Both the interactive TUI entrypoint and the headless sub-agent child
 *   process need to construct an identical client, but the child must not pull
 *   in the Ink/React entrypoint (which renders on import).
 * - The OAuth branch points at the Codex backend with custom headers and a
 *   token-refreshing fetch, while API-key sessions keep the public OpenAI API.
 */
export function buildAgentClient(resolved: ResolvedConfig, authState?: ProviderAuthState): AgentClient {
  const bearerToken = authState?.bearerToken || resolved.apiKey || undefined;
  const isOpenAIOAuth = resolved.providerName === "openai" && authState?.authMode === "oauth" && authState.oauth;

  const clientOptions = isOpenAIOAuth
    ? {
        apiKey: bearerToken,
        baseURL: OPENAI_CODEX_BASE_URL,
        defaultHeaders: getOpenAIOAuthDefaultHeaders(authState.oauth as StoredOAuthCredentials),
        fetch: createOpenAIOAuthFetch(),
      }
    : {
        apiKey: bearerToken,
        baseURL: resolved.baseURL !== "https://api.openai.com/v1" ? resolved.baseURL : undefined,
        // 共享 dispatcher 把闲置 keep-alive 连接保留时间压到 1s，避免在多轮工具
        // 执行的间隔后下一轮 stream 拿到一条已被远端关闭的连接、立刻报 `terminated`。
        fetch: createSharedFetch(),
      };

  return {
    client: new OpenAI(clientOptions),
    supportsPreviousResponseId: !isOpenAIOAuth,
  };
}
