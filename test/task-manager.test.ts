import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskManager } from "../src/task-manager.js";

function tempTasksDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-manager-test-"));
}

test("TaskManager creates tasks with correct properties", async () => {
  const dir = tempTasksDir();
  const manager = new TaskManager(dir);

  const res1 = await manager.create("Task 1", "Description 1", "lead");
  const task1 = JSON.parse(res1);

  assert.equal(task1.id, 1);
  assert.equal(task1.subject, "Task 1");
  assert.equal(task1.description, "Description 1");
  assert.equal(task1.status, "pending");
  assert.equal(task1.owner, "lead");
  assert.equal(task1.threadId, "task_1");

  const res2 = await manager.create("Task 2", "Description 2", "lead", "teammate_bob");
  const task2 = JSON.parse(res2);

  assert.equal(task2.id, 2);
  assert.equal(task2.subject, "Task 2");
  assert.equal(task2.status, "assigned");
  assert.equal(task2.assignee, "teammate_bob");
});

test("TaskManager updates task status, blockedBy, blocks, assignee, and results", async () => {
  const dir = tempTasksDir();
  const manager = new TaskManager(dir);

  const res1 = await manager.create("Task 1");
  const task1 = JSON.parse(res1);

  const res2 = await manager.create("Task 2");
  const task2 = JSON.parse(res2);

  // Task 2 blocks Task 1
  const updatedRes1 = await manager.update(task1.id, "blocked", [task2.id], undefined, "teammate_alice", undefined, "Waiting for Task 2");
  const updated1 = JSON.parse(updatedRes1);

  assert.equal(updated1.status, "blocked");
  assert.equal(updated1.assignee, "teammate_alice");
  assert.deepEqual(updated1.blockedBy, [task2.id]);
  assert.equal(updated1.blockedReason, "Waiting for Task 2");

  // Check that Task 2 blocks list contains Task 1
  const task2Retrieved = await manager.getTask(task2.id);
  assert.ok(task2Retrieved);
  assert.deepEqual(task2Retrieved.blocks, [task1.id]);

  // Complete Task 2
  await manager.update(task2.id, "completed", undefined, undefined, undefined, "Done with 2");

  // Task 1 should automatically be unblocked (blockedBy cleared)
  const task1Retrieved = await manager.getTask(task1.id);
  assert.ok(task1Retrieved);
  assert.deepEqual(task1Retrieved.blockedBy, []);
});

test("TaskManager lists tasks, formatTask, and manages active tasks", async () => {
  const dir = tempTasksDir();
  const manager = new TaskManager(dir);

  assert.equal(await manager.hasActiveTasks(), false);
  assert.equal(await manager.list(), "(no tasks)");

  await manager.create("Task 1");
  assert.equal(await manager.hasActiveTasks(), true);

  const listStr = await manager.list();
  assert.match(listStr, /#1: Task 1/);

  const formattedStr = await manager.formatTask(1);
  assert.match(formattedStr, /status=pending/);
  assert.match(formattedStr, /#1 Task 1/);
});

test("TaskManager handles concurrent creation safely without ID clashes or file corruption", async () => {
  const dir = tempTasksDir();
  const manager = new TaskManager(dir);

  const concurrency = 15;
  const promises = Array.from({ length: concurrency }, (_, i) =>
    manager.create(`Subject ${i}`, `Desc ${i}`)
  );

  const results = await Promise.all(promises);
  assert.equal(results.length, concurrency);

  const tasksList = await manager.listTasks();
  assert.equal(tasksList.length, concurrency);

  const ids = tasksList.map(t => t.id).sort((a, b) => a - b);
  const expectedIds = Array.from({ length: concurrency }, (_, i) => i + 1);
  assert.deepEqual(ids, expectedIds);
});
