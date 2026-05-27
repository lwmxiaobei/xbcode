import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "assigned" | "in_progress" | "blocked" | "completed" | "failed";
  owner: string;
  assignee?: string;
  threadId: string;
  resultSummary?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
  blockedBy: number[];
  blocks: number[];
}

const STATUS_SYMBOLS: Record<Task["status"], string> = {
  pending: "[ ]",
  assigned: "[=]",
  in_progress: "[>]",
  blocked: "[! ]",
  completed: "[x]",
  failed: "[-]",
};

const LOCK_OPTIONS = {
  retries: {
    retries: 100,
    minTimeout: 5,
    maxTimeout: 200,
  },
} as const;

function createThreadId(taskId: number): string {
  return `task_${taskId}`;
}

export class TaskManager {
  private dir: string;
  private lockFilePath: string;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.lockFilePath = path.join(this.dir, "tasks.lock");
    if (!fs.existsSync(this.lockFilePath)) {
      fs.writeFileSync(this.lockFilePath, "", "utf8");
    }
  }

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await lockfile.lock(this.lockFilePath, LOCK_OPTIONS);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private nextId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    if (files.length === 0) return 1;
    const ids = files.map((f) => Number(f.match(/task_(\d+)\.json/)?.[1] ?? 0));
    return Math.max(...ids) + 1;
  }

  private taskPath(id: number): string {
    return path.join(this.dir, `task_${id}.json`);
  }

  private normalizeTask(task: Task): Task {
    const now = new Date().toISOString();
    return {
      id: task.id,
      subject: task.subject,
      description: task.description ?? "",
      status: task.status ?? "pending",
      owner: task.owner ?? "lead",
      assignee: task.assignee,
      threadId: task.threadId ?? createThreadId(task.id),
      resultSummary: task.resultSummary,
      blockedReason: task.blockedReason,
      createdAt: task.createdAt ?? now,
      updatedAt: task.updatedAt ?? task.createdAt ?? now,
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
      blocks: Array.isArray(task.blocks) ? task.blocks : [],
    };
  }

  private load(id: number): Task {
    const content = fs.readFileSync(this.taskPath(id), "utf8");
    return this.normalizeTask(JSON.parse(content) as Task);
  }

  private save(task: Task): void {
    const normalized = this.normalizeTask(task);
    fs.writeFileSync(this.taskPath(normalized.id), JSON.stringify(normalized, null, 2), "utf8");
  }

  private allTasks(): Task[] {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    return files.map((f) => {
      const id = Number(f.match(/task_(\d+)\.json/)?.[1] ?? 0);
      return this.load(id);
    });
  }

  private getTaskInternal(taskId: number): Task | null {
    try {
      return this.load(taskId);
    } catch {
      return null;
    }
  }

  async create(subject: string, description?: string, owner = "lead", assignee?: string): Promise<string> {
    return this.withLock(() => {
      const id = this.nextId();
      const now = new Date().toISOString();
      const task: Task = {
        id,
        subject,
        description: description ?? "",
        status: assignee ? "assigned" : "pending",
        owner,
        assignee,
        threadId: createThreadId(id),
        createdAt: now,
        updatedAt: now,
        blockedBy: [],
        blocks: [],
      };
      this.save(task);
      return JSON.stringify(task, null, 2);
    });
  }

  async update(
    taskId: number,
    status?: string,
    addBlockedBy?: number[],
    addBlocks?: number[],
    assignee?: string,
    resultSummary?: string,
    blockedReason?: string,
  ): Promise<string> {
    return this.withLock(() => {
      let task: Task;
      try {
        task = this.load(taskId);
      } catch {
        return `Error: Task ${taskId} not found.`;
      }

      if (addBlockedBy) {
        for (const depId of addBlockedBy) {
          if (!task.blockedBy.includes(depId)) task.blockedBy.push(depId);
          try {
            const dep = this.load(depId);
            if (!dep.blocks.includes(taskId)) {
              dep.blocks.push(taskId);
              dep.updatedAt = new Date().toISOString();
              this.save(dep);
            }
          } catch {}
        }
      }

      if (addBlocks) {
        for (const depId of addBlocks) {
          if (!task.blocks.includes(depId)) task.blocks.push(depId);
          try {
            const dep = this.load(depId);
            if (!dep.blockedBy.includes(taskId)) {
              dep.blockedBy.push(taskId);
              dep.updatedAt = new Date().toISOString();
              this.save(dep);
            }
          } catch {}
        }
      }

      if (typeof assignee === "string" && assignee.trim()) {
        task.assignee = assignee.trim();
        if (task.status === "pending") {
          task.status = "assigned";
        }
      }

      if (typeof resultSummary === "string") {
        task.resultSummary = resultSummary;
      }

      if (typeof blockedReason === "string") {
        task.blockedReason = blockedReason;
      }

      if (status) {
        task.status = status as Task["status"];
        if (status !== "blocked") {
          task.blockedReason = blockedReason ?? task.blockedReason;
        }
      }

      task.updatedAt = new Date().toISOString();
      this.save(task);

      if (task.status === "completed") {
        this.clearDependency(task.id);
      }

      return JSON.stringify(task, null, 2);
    });
  }

  private clearDependency(completedId: number): void {
    const all = this.allTasks();
    for (const t of all) {
      const idx = t.blockedBy.indexOf(completedId);
      if (idx !== -1) {
        t.blockedBy.splice(idx, 1);
        t.updatedAt = new Date().toISOString();
        this.save(t);
      }
    }
  }

  async list(): Promise<string> {
    return this.withLock(() => {
      const tasks = this.allTasks();
      if (tasks.length === 0) return "(no tasks)";
      return tasks
        .map((t) => {
          let line = `${STATUS_SYMBOLS[t.status]} #${t.id}: ${t.subject}`;
          if (t.assignee) line += ` assignee=${t.assignee}`;
          if (t.blockedBy.length > 0) line += ` (blocked by: ${t.blockedBy.join(", ")})`;
          if (t.blockedReason) line += ` reason=${t.blockedReason}`;
          return line;
        })
        .join("\n");
    });
  }

  async getTask(taskId: number): Promise<Task | null> {
    return this.withLock(() => {
      return this.getTaskInternal(taskId);
    });
  }

  async listTasks(): Promise<Task[]> {
    return this.withLock(() => {
      return this.allTasks().sort((left, right) => left.id - right.id);
    });
  }

  async listAssignedTo(name: string): Promise<Task[]> {
    return this.withLock(() => {
      const normalized = name.trim();
      return this.allTasks()
        .filter((task) => task.assignee === normalized && ["assigned", "in_progress", "blocked"].includes(task.status))
        .sort((left, right) => left.id - right.id);
    });
  }

  async claimNext(assignee: string): Promise<Task | null> {
    return this.withLock(() => {
      const nextTask = this.allTasks()
        .filter((task) => task.assignee === assignee && task.status === "assigned")
        .sort((left, right) => left.id - right.id)[0];

      if (!nextTask) {
        return null;
      }

      nextTask.status = "in_progress";
      nextTask.updatedAt = new Date().toISOString();
      this.save(nextTask);
      return nextTask;
    });
  }

  async formatTask(taskId: number): Promise<string> {
    return this.withLock(() => {
      const task = this.getTaskInternal(taskId);
      if (!task) {
        return `Error: Task ${taskId} not found.`;
      }

      const lines = [
        `#${task.id} ${task.subject}`,
        `status=${task.status}`,
        `owner=${task.owner}`,
        `assignee=${task.assignee ?? "-"}`,
        `thread=${task.threadId}`,
        `created_at=${task.createdAt}`,
        `updated_at=${task.updatedAt}`,
      ];

      if (task.description) lines.push("", task.description);
      if (task.resultSummary) lines.push("", `result: ${task.resultSummary}`);
      if (task.blockedReason) lines.push("", `blocked: ${task.blockedReason}`);
      if (task.blockedBy.length > 0) lines.push(`blocked_by=${task.blockedBy.join(", ")}`);
      if (task.blocks.length > 0) lines.push(`blocks=${task.blocks.join(", ")}`);

      return lines.join("\n");
    });
  }

  async get(taskId: number): Promise<string> {
    return this.withLock(() => {
      const task = this.getTaskInternal(taskId);
      return task ? JSON.stringify(task, null, 2) : `Error: Task ${taskId} not found.`;
    });
  }

  async hasActiveTasks(): Promise<boolean> {
    return this.withLock(() => {
      return this.allTasks().some((t) => ["pending", "assigned", "in_progress", "blocked"].includes(t.status));
    });
  }
}
