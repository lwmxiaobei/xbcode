import test from "node:test";
import assert from "node:assert/strict";

import { countTokens, truncateMiddleWithTokenBudget } from "../src/truncate.js";

test("内容未达 token 上限时原样返回", () => {
  assert.deepEqual(truncateMiddleWithTokenBudget("short", 100), { text: "short" });
  assert.deepEqual(truncateMiddleWithTokenBudget("", 100), { text: "" });
});

test("恰好等于 token 上限时不截断", () => {
  const text = "one two three";
  assert.deepEqual(truncateMiddleWithTokenBudget(text, countTokens(text)), { text });
});

test("超出上限时保留头尾并追加 token 截断提示", () => {
  const text = Array.from({ length: 100 }, (_, index) => `item_${index}`).join(" ");
  const result = truncateMiddleWithTokenBudget(text, 20);

  assert.equal(result.truncatedTokens, countTokens(text) - 20);
  assert.match(result.text, /\n…\d+ tokens truncated…\n/);
  assert.match(result.text, /^item_0/);
  assert.match(result.text, /item_99$/);
});

test("未知模型使用默认编码完成 token 计数", () => {
  assert.equal(countTokens("hello world", "unknown-model"), countTokens("hello world"));
});
