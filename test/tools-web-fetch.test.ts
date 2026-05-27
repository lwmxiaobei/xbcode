import test from "node:test";
import assert from "node:assert/strict";
import { validateFetchUrl, stripHtml, BASE_TOOL_HANDLERS } from "../src/tools.js";

test("validateFetchUrl rejects long URL", () => {
  const longUrl = "https://example.com/" + "a".repeat(2000);
  assert.throws(() => validateFetchUrl(longUrl), /URL too long/);
});

test("validateFetchUrl rejects unsupported protocols", () => {
  assert.throws(() => validateFetchUrl("ftp://example.com"), /Unsupported protocol/);
  assert.throws(() => validateFetchUrl("file:///etc/passwd"), /Unsupported protocol/);
});

test("validateFetchUrl rejects credentials", () => {
  assert.throws(() => validateFetchUrl("https://user:pass@example.com"), /credentials/);
});

test("validateFetchUrl rejects internal domains", () => {
  assert.throws(() => validateFetchUrl("https://localhost"), /publicly resolvable domain/);
  assert.throws(() => validateFetchUrl("https://my-internal-server"), /publicly resolvable domain/);
});

test("validateFetchUrl upgrades http to https", () => {
  const res = validateFetchUrl("http://example.com/docs");
  assert.equal(res.protocol, "https:");
});

test("stripHtml strips scripts and styles", () => {
  const html = "<div>Hello <script>console.log('hi')</script><style>body { color: red; }</style>World</div>";
  assert.equal(stripHtml(html), "Hello World");
});

test("stripHtml decodes named and numeric HTML entities", () => {
  const html = "A &amp; B &lt; C &gt; D &quot; E &apos; F &#39; G &nbsp; H &#65; I &#x42; J";
  assert.equal(stripHtml(html), "A & B < C > D \" E ' F ' G H A I B J");
});

test("stripHtml format structures block tags into line breaks and collapses spacing", () => {
  const html = "<h1>Header</h1><p>Paragraph 1<br>Break</p><div>Div content</div>";
  const text = stripHtml(html);
  assert.equal(text, "Header\nParagraph 1\nBreak\nDiv content");
});

test("web_fetch handler outputs formatted body for HTML", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, _init) => {
      assert.equal(String(input), "https://example.com/page");
      return new Response("<html><body><h1>Hello World</h1><p>Test</p></body></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_fetch({ url: "https://example.com/page" });
    assert.match(res, /Status: 200/);
    assert.match(res, /Content-Type: text\/html/);
    assert.match(res, /Hello World/);
    assert.match(res, /Test/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_fetch handler handles plain text without HTML stripping", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response("This is <b>not</b> HTML, but plain text.", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/plain" },
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_fetch({ url: "https://example.com/text" });
    assert.match(res, /This is <b>not<\/b> HTML/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_fetch handler handles HTTP error gracefully", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      return new Response("Not Found", {
        status: 404,
        statusText: "Not Found",
      });
    };

    const res = await BASE_TOOL_HANDLERS.web_fetch({ url: "https://example.com/404" });
    assert.match(res, /Error: HTTP 404 Not Found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
