import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendSessionCheckpoint, createSessionId, listRecentSessions, loadSession } from "../src/session-store.js";
import type { AgentState, PersistedUiMessage } from "../src/types.js";

function buildState(sessionId: string, launchedAt: number): AgentState {
  return {
    sessionId,
    responseHistory: [],
    chatHistory: [{ role: "user", content: "帮我实现历史会话保存" }],
    turnCount: 2,
    launchedAt,
    roundsSinceTask: 0,
    compactCount: 0,
  };
}

function buildMessages(text: string): PersistedUiMessage[] {
  return [
    { kind: "user", text },
    { kind: "assistant", text: "已分析现有实现。" },
  ];
}

test("session store saves and restores the latest checkpoint for a workspace", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xbcode-session-"));
  process.env.XBCODE_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "xbcode-session-root-"));
  const sessionId = createSessionId(new Date("2026-04-22T10:00:00.000Z"));
  const stateWithGoal = buildState(sessionId, Date.parse("2026-04-22T10:00:00.000Z"));
  stateWithGoal.goal = {
    id: "goal-1",
    objective: "完成恢复测试",
    status: "active",
    tokenBudget: 5000,
    tokensUsed: 120,
    timeUsedSeconds: 8,
    createdAt: Date.parse("2026-04-22T10:00:00.000Z"),
    updatedAt: Date.parse("2026-04-22T10:01:00.000Z"),
  };

  appendSessionCheckpoint(workspace, {
    state: stateWithGoal,
    messages: buildMessages("先研究 claude code 的 session 存储"),
    providerName: "openai",
    model: "gpt-5.4",
    apiMode: "responses",
    savedAt: "2026-04-22T10:01:00.000Z",
  });

  appendSessionCheckpoint(workspace, {
    state: {
      ...stateWithGoal,
      turnCount: 3,
    },
    messages: buildMessages("先研究 claude code 的 session 存储"),
    providerName: "openai",
    model: "gpt-5.4",
    apiMode: "responses",
    savedAt: "2026-04-22T10:02:00.000Z",
  });

  const restored = loadSession(workspace, sessionId);
  assert.ok(restored);
  assert.equal(restored.state.sessionId, sessionId);
  assert.equal(restored.state.turnCount, 3);
  assert.equal(restored.state.goal?.objective, "完成恢复测试");
  assert.equal(restored.state.goal?.tokensUsed, 120);
  assert.equal(restored.messages[0]?.text, "先研究 claude code 的 session 存储");
});

test("session store lists recent sessions newest first with the first user message as title", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "xbcode-session-list-"));
  process.env.XBCODE_SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "xbcode-session-root-"));
  const olderSessionId = createSessionId(new Date("2026-04-22T09:00:00.000Z"));
  const newerSessionId = createSessionId(new Date("2026-04-22T11:00:00.000Z"));

  appendSessionCheckpoint(workspace, {
    state: buildState(olderSessionId, Date.parse("2026-04-22T09:00:00.000Z")),
    messages: buildMessages("旧会话"),
    providerName: "openai",
    model: "gpt-5.4",
    apiMode: "responses",
    savedAt: "2026-04-22T09:05:00.000Z",
  });

  appendSessionCheckpoint(workspace, {
    state: buildState(newerSessionId, Date.parse("2026-04-22T11:00:00.000Z")),
    messages: buildMessages("新会话标题需要展示"),
    providerName: "openai",
    model: "gpt-5.4-mini",
    apiMode: "responses",
    savedAt: "2026-04-22T11:05:00.000Z",
  });

  const sessions = listRecentSessions(workspace);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0]?.sessionId, newerSessionId);
  assert.equal(sessions[0]?.title, "新会话标题需要展示");
  assert.equal(sessions[1]?.sessionId, olderSessionId);
});
