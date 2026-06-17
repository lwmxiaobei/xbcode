import assert from "node:assert/strict";
import test from "node:test";

import {
  accountGoalTurn,
  buildGoalContinuationPrompt,
  createGoal,
  goalCanResume,
  pauseActiveGoal,
  setGoalBudget,
  setGoalStatus,
  updateGoalFromModel,
} from "../src/goal-manager.js";
import { TEAMMATE_TOOLS, TOOLS } from "../src/tools.js";
import type { AgentState } from "../src/types.js";

function buildState(): AgentState {
  return {
    sessionId: "goal-session",
    responseHistory: [],
    chatHistory: [],
    turnCount: 0,
    launchedAt: Date.now(),
    roundsSinceTask: 0,
    compactCount: 0,
  };
}

test("goal tools are visible only to the lead agent", () => {
  const leadNames = TOOLS.map((tool) => tool.name);
  const teammateNames = TEAMMATE_TOOLS.map((tool) => tool.name);

  for (const name of ["get_goal", "create_goal", "update_goal"]) {
    assert.ok(leadNames.includes(name));
    assert.ok(!teammateNames.includes(name));
  }
});

test("goal creation rejects replacement until the current goal completes", () => {
  const state = buildState();

  assert.doesNotMatch(createGoal(state, "Implement the API", 1000), /^Error:/);
  assert.match(createGoal(state, "Replace it"), /unfinished goal/);
  assert.match(updateGoalFromModel(state, "paused"), /only set status/);
  assert.doesNotMatch(updateGoalFromModel(state, "complete"), /^Error:/);
  assert.doesNotMatch(createGoal(state, "Replace it"), /^Error:/);
});

test("goal accounting stops automatic continuation at the token budget", () => {
  const state = buildState();
  createGoal(state, "Finish all tests", 100);
  const goalId = state.goal?.id;

  accountGoalTurn(
    state,
    goalId,
    { inputTokens: 70, outputTokens: 30, cachedInputTokens: 50, cost: 0 },
    1200,
  );

  assert.equal(state.goal?.tokensUsed, 100);
  assert.equal(state.goal?.timeUsedSeconds, 2);
  assert.equal(state.goal?.status, "budget_limited");
});

test("goal accounting ignores turns that were not attached to an active goal", () => {
  const state = buildState();
  createGoal(state, "Already done");
  updateGoalFromModel(state, "complete");

  accountGoalTurn(
    state,
    undefined,
    { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, cost: 0 },
    1000,
  );

  assert.equal(state.goal?.tokensUsed, 0);
  assert.equal(state.goal?.timeUsedSeconds, 0);
});

test("raising an exhausted budget makes the goal resumable but does not auto-resume it", () => {
  const state = buildState();
  createGoal(state, "Finish all tests", 10);
  accountGoalTurn(
    state,
    state.goal?.id,
    { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cost: 0 },
    1,
  );

  assert.equal(state.goal?.status, "budget_limited");
  setGoalBudget(state, 100);
  assert.equal(state.goal?.status, "paused");
  assert.equal(goalCanResume(state.goal), true);
  setGoalStatus(state, "active");
  assert.equal(state.goal?.status, "active");
});

test("active goal can be paused and continuation prompt preserves the full objective", () => {
  const state = buildState();
  createGoal(state, "Implement <goal> & verify it");

  const prompt = buildGoalContinuationPrompt(state.goal!);
  assert.match(prompt, /Implement &lt;goal&gt; &amp; verify it/);
  assert.match(prompt, /Only call update_goal with status "complete"/);
  assert.equal(pauseActiveGoal(state), true);
  assert.equal(state.goal?.status, "paused");
});
