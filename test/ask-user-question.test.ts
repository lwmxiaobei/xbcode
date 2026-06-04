import test from "node:test";
import assert from "node:assert/strict";

import {
  ASK_USER_QUESTION_TOOL_NAME,
  parseUserChoiceQuestions,
  formatUserChoiceResult,
} from "../src/agent.js";

test("工具名常量与 schema 注册保持一致", () => {
  assert.equal(ASK_USER_QUESTION_TOOL_NAME, "ask_user_question");
});

test("parse: 解析合法问题，保留 header / multiSelect / 选项描述", () => {
  const parsed = parseUserChoiceQuestions([
    {
      header: "方案",
      question: "用哪个方案？",
      multiSelect: true,
      options: [
        { label: "A", description: "方案 A" },
        { label: "B" },
      ],
    },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].header, "方案");
  assert.equal(parsed[0].multiSelect, true);
  assert.deepEqual(parsed[0].options, [
    { label: "A", description: "方案 A" },
    { label: "B" },
  ]);
});

test("parse: multiSelect 缺省时归一化为 false", () => {
  const parsed = parseUserChoiceQuestions([
    { question: "Q?", options: [{ label: "A" }] },
  ]);
  assert.equal(parsed[0].multiSelect, false);
});

test("parse: 丢弃缺 question 或缺选项的脏问题", () => {
  const parsed = parseUserChoiceQuestions([
    { question: "", options: [{ label: "A" }] },
    { question: "Q?", options: [] },
    { question: "Keep?", options: [{ label: "ok" }] },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].question, "Keep?");
});

test("parse: 丢弃无 label 的选项，整题选项为空则丢弃该题", () => {
  const parsed = parseUserChoiceQuestions([
    { question: "Q?", options: [{ description: "无 label" }, { label: "  " }] },
  ]);
  assert.equal(parsed.length, 0);
});

test("parse: 非数组输入安全返回空数组", () => {
  assert.deepEqual(parseUserChoiceQuestions(undefined), []);
  assert.deepEqual(parseUserChoiceQuestions("nope"), []);
  assert.deepEqual(parseUserChoiceQuestions({ questions: [] }), []);
});

test("format: 单题回填所选 label", () => {
  const questions = parseUserChoiceQuestions([
    { question: "用哪个？", options: [{ label: "A" }, { label: "B" }] },
  ]);
  const result = formatUserChoiceResult(questions, [["A"]]);
  assert.match(result, /The user answered/);
  assert.match(result, /Q: 用哪个？/);
  assert.match(result, /Selected: A/);
});

test("format: 多选用逗号连接多个 label", () => {
  const questions = parseUserChoiceQuestions([
    { question: "选哪些？", multiSelect: true, options: [{ label: "A" }, { label: "B" }, { label: "C" }] },
  ]);
  const result = formatUserChoiceResult(questions, [["A", "C"]]);
  assert.match(result, /Selected: A, C/);
});

test("format: 未作答的题显示 (no selection)", () => {
  const questions = parseUserChoiceQuestions([
    { question: "Q1?", options: [{ label: "A" }] },
    { question: "Q2?", options: [{ label: "B" }] },
  ]);
  const result = formatUserChoiceResult(questions, [["A"]]);
  assert.match(result, /Q: Q2\?\nSelected: \(no selection\)/);
});
