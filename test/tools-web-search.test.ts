import test from "node:test";
import assert from "node:assert/strict";

import { BASE_TOOLS, BASE_TOOL_HANDLERS } from "../src/tools.js";

const SEARCH_KEY_NAMES = [
  "ASK_ECHO_SEARCH_INFINITY_API_KEY",
  "VOLCENGINE_SEARCH_API_KEY",
  "ARK_SEARCH_API_KEY",
  "BRAVE_SEARCH_API_KEY",
] as const;

type SearchEnvSnapshot = Record<(typeof SEARCH_KEY_NAMES)[number], string | undefined>;

function snapshotSearchEnv(): SearchEnvSnapshot {
  return Object.fromEntries(SEARCH_KEY_NAMES.map((name) => [name, process.env[name]])) as SearchEnvSnapshot;
}

function clearSearchEnv(): void {
  for (const name of SEARCH_KEY_NAMES) delete process.env[name];
}

function restoreSearchEnv(snapshot: SearchEnvSnapshot): void {
  for (const name of SEARCH_KEY_NAMES) {
    const value = snapshot[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

test("web_search tool is registered in BASE_TOOLS and routed", () => {
  const names = BASE_TOOLS.map((tool) => tool.name);
  assert.ok(names.includes("web_search"), "web_search should be registered in BASE_TOOLS");
  assert.ok(typeof BASE_TOOL_HANDLERS.web_search === "function", "web_search handler should be wired");
});

test("web_search reports missing Volcengine API key", async () => {
  const envSnapshot = snapshotSearchEnv();
  try {
    clearSearchEnv();
    const res = await BASE_TOOL_HANDLERS.web_search({ query: "openai docs" });
    assert.equal(res, "Error: ASK_ECHO_SEARCH_INFINITY_API_KEY is not set");
  } finally {
    restoreSearchEnv(envSnapshot);
  }
});

test("web_search sends query and formats Volcengine results", async () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot = snapshotSearchEnv();
  try {
    clearSearchEnv();
    process.env.ASK_ECHO_SEARCH_INFINITY_API_KEY = "test-key";
    globalThis.fetch = async (input, init) => {
      assert.equal(String(input), "https://open.feedcoopapi.com/search_api/web_search");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test-key");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        Query: "OpenAI Responses API",
        SearchType: "web",
        Count: 2,
        NeedSummary: true,
      });

      return new Response(JSON.stringify({
        ResponseMetadata: {
          RequestId: "request-123",
        },
        Result: {
          WebResults: [
            {
              Title: "Responses API",
              Url: "https://platform.openai.com/docs/api-reference/responses",
              Snippet: "Create model responses.",
              Summary: "Official Responses API reference.",
              SiteName: "OpenAI",
              PublishTime: "2026-07-01T10:00:00+08:00",
            },
            {
              Title: "OpenAI Docs",
              Url: "https://platform.openai.com/docs",
              Snippet: "Developer documentation.",
            },
          ],
        },
      }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_search({
      query: "OpenAI Responses API",
      count: 2,
    });
    assert.match(res, /Query: OpenAI Responses API/);
    assert.match(res, /Provider: Volcengine Search Infinity/);
    assert.match(res, /Request ID: request-123/);
    assert.match(res, /1\. Responses API/);
    assert.match(res, /URL: https:\/\/platform\.openai\.com\/docs\/api-reference\/responses/);
    assert.match(res, /Snippet: Create model responses\./);
    assert.match(res, /Summary: Official Responses API reference\./);
    assert.match(res, /Site: OpenAI/);
    assert.match(res, /Published: 2026-07-01T10:00:00\+08:00/);
    assert.match(res, /2\. OpenAI Docs/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSearchEnv(envSnapshot);
  }
});

test("web_search caps count to 10", async () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot = snapshotSearchEnv();
  try {
    clearSearchEnv();
    process.env.ASK_ECHO_SEARCH_INFINITY_API_KEY = "test-key";
    globalThis.fetch = async (_input, init) => {
      assert.equal(JSON.parse(String(init?.body)).Count, 10);
      return new Response(JSON.stringify({ Result: { WebResults: [] } }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_search({ query: "test", count: 50 });
    assert.equal(res, "No search results");
  } finally {
    globalThis.fetch = originalFetch;
    restoreSearchEnv(envSnapshot);
  }
});

test("web_search handles HTTP error gracefully", async () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot = snapshotSearchEnv();
  try {
    clearSearchEnv();
    process.env.ASK_ECHO_SEARCH_INFINITY_API_KEY = "test-key";
    globalThis.fetch = async () => {
      return new Response("Too Many Requests", {
        status: 429,
        statusText: "Too Many Requests",
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_search({ query: "test" });
    assert.equal(res, "Error: HTTP 429 Too Many Requests");
  } finally {
    globalThis.fetch = originalFetch;
    restoreSearchEnv(envSnapshot);
  }
});

test("web_search surfaces Volcengine API errors", async () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot = snapshotSearchEnv();
  try {
    clearSearchEnv();
    process.env.ASK_ECHO_SEARCH_INFINITY_API_KEY = "test-key";
    globalThis.fetch = async () => new Response(JSON.stringify({
      ResponseMetadata: {
        Error: {
          Code: "InvalidAccountId",
          Message: "search service is not enabled",
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const res = await BASE_TOOL_HANDLERS.web_search({ query: "test" });
    assert.equal(res, "Error: Volcengine Search InvalidAccountId: search service is not enabled");
  } finally {
    globalThis.fetch = originalFetch;
    restoreSearchEnv(envSnapshot);
  }
});

test("web_search falls back to Brave when Volcengine key is absent", async () => {
  const originalFetch = globalThis.fetch;
  const envSnapshot = snapshotSearchEnv();
  try {
    clearSearchEnv();
    process.env.BRAVE_SEARCH_API_KEY = "brave-key";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
      assert.equal((init?.headers as Record<string, string>)["X-Subscription-Token"], "brave-key");
      return new Response(JSON.stringify({
        web: {
          results: [{
            title: "Fallback result",
            url: "https://example.com",
            description: "Brave result",
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_search({ query: "fallback" });
    assert.match(res, /Provider: Brave Search/);
    assert.match(res, /1\. Fallback result/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreSearchEnv(envSnapshot);
  }
});
