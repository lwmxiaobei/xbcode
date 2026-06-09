import test from "node:test";
import assert from "node:assert/strict";

import { BASE_TOOLS, BASE_TOOL_HANDLERS } from "../src/tools.js";

test("web_search tool is registered in BASE_TOOLS and routed", () => {
  const names = BASE_TOOLS.map((tool) => tool.name);
  assert.ok(names.includes("web_search"), "web_search should be registered in BASE_TOOLS");
  assert.ok(typeof BASE_TOOL_HANDLERS.web_search === "function", "web_search handler should be wired");
});

test("web_search reports missing Brave API key", async () => {
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  try {
    delete process.env.BRAVE_SEARCH_API_KEY;
    const res = await BASE_TOOL_HANDLERS.web_search({ query: "openai docs" });
    assert.equal(res, "Error: BRAVE_SEARCH_API_KEY is not set");
  } finally {
    if (originalKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalKey;
    }
  }
});

test("web_search sends query and formats Brave results", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  try {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
      assert.equal(url.searchParams.get("q"), "OpenAI Responses API");
      assert.equal(url.searchParams.get("count"), "2");
      assert.equal((init?.headers as Record<string, string>)["X-Subscription-Token"], "test-key");

      return new Response(JSON.stringify({
        web: {
          results: [
            {
              title: "Responses API",
              url: "https://platform.openai.com/docs/api-reference/responses",
              description: "Create model responses.",
            },
            {
              title: "OpenAI Docs",
              url: "https://platform.openai.com/docs",
              description: "Developer documentation.",
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
    assert.match(res, /Provider: Brave Search/);
    assert.match(res, /1\. Responses API/);
    assert.match(res, /URL: https:\/\/platform\.openai\.com\/docs\/api-reference\/responses/);
    assert.match(res, /Snippet: Create model responses\./);
    assert.match(res, /2\. OpenAI Docs/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalKey;
    }
  }
});

test("web_search caps count to 10", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  try {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get("count"), "10");
      return new Response(JSON.stringify({ web: { results: [] } }), {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "application/json" },
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_search({ query: "test", count: 50 });
    assert.equal(res, "No search results");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalKey;
    }
  }
});

test("web_search handles HTTP error gracefully", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.BRAVE_SEARCH_API_KEY;
  try {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
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
    if (originalKey === undefined) {
      delete process.env.BRAVE_SEARCH_API_KEY;
    } else {
      process.env.BRAVE_SEARCH_API_KEY = originalKey;
    }
  }
});
