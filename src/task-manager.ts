import fs from "node:fs";
import path from "node:path";

export interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
  blocks: number[];
}

const STATUS_SYMBOLS: Record<Task["status"], string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

export class TaskManager {
  private dir: string;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
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

  private load(id: number): Task {
    const content = fs.readFileSync(this.taskPath(id), "utf8");
    return JSON.parse(content) as Task;
  }

  private save(task: Task): void {
    fs.writeFileSync(this.taskPath(task.id), JSON.stringify(task, null, 2), "utf8");
  }

  private allTasks(): Task[] {
    const files = fs.readdirSync(this.dir).filter((f) => /^task_\d+\.json$/.test(f));
    return files.map((f) => {
      const id = Number(f.match(/task_(\d+)\.json/)?.[1] ?? 0);
      return this.load(id);
    });
  }

  create(subject: string, description?: string): string {
    const id = this.nextId();
    const task: Task = {
      id,
      subject,
      description: description ?? "",
      status: "pending",
      blockedBy: [],
      blocks: [],
    };
    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    let task: Task;
    try {
      task = this.load(taskId);
    } catch {
      return `Error: Task ${taskId} not found.`;
    }

    if (addBlockedBy) {
      for (const depId of addBlockedBy) {
        if (!task.blockedBy.includes(depId)) task.blockedBy.push(depId);
        // Update the reverse side
        try {
          const dep = this.load(depId);
          if (!dep.blocks.includes(taskId)) {
            dep.blocks.push(taskId);
            this.save(dep);
          }
        } catch { /* dep not found, skip */ }
      }
    }

    if (addBlocks) {
      for (const depId of addBlocks) {
        if (!task.blocks.includes(depId)) task.blocks.push(depId);
        // Update the reverse side
        try {
          const dep = this.load(depId);
          if (!dep.blockedBy.includes(taskId)) {
            dep.blockedBy.push(taskId);
            this.save(dep);
          }
        } catch { /* dep not found, skip */ }
      }
    }

    if (status) {
      task.status = status as Task["status"];
    }

    this.save(task);

    if (task.status === "completed") {
      this.clearDependency(task.id);
    }

    return JSON.stringify(task, null, 2);
  }

  private clearDependency(completedId: number): void {
    const all = this.allTasks();
    for (const t of all) {
      const idx = t.blockedBy.indexOf(completedId);
      if (idx !== -1) {
        t.blockedBy.splice(idx, 1);
        this.save(t);
      }
    }
  }

  list(): string {
    const tasks = this.allTasks();
    if (tasks.length === 0) return "(no tasks)";
    return tasks
      .map((t) => {
        let line = `${STATUS_SYMBOLS[t.status]} #${t.id}: ${t.subject}`;
        if (t.blockedBy.length > 0) line += ` (blocked by: ${t.blockedBy.join(", ")})`;
        return line;
      })
      .join("\n");
  }

  get(taskId: number): string {
    try {
      return JSON.stringify(this.load(taskId), null, 2);
    } catch {
      return `Error: Task ${taskId} not found.`;
    }
  }

  hasActiveTasks(): boolean {
    return this.allTasks().some((t) => t.status === "pending" || t.status === "in_progress");
  }
}
