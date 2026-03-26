import fs from "node:fs";
import path from "node:path";

import { MessageBus } from "./message-bus.js";
import type { TeamConfig, TeamMemberStatus, TeammateRecord, TeammateRuntimeState } from "./team-types.js";

export type TeammateRuntimeControl = {
  name: string;
  role: string;
  stopRequested: boolean;
  waiters: Set<() => void>;
  running?: Promise<void>;
  state: TeammateRuntimeState;
};

type RuntimeRunner = (control: TeammateRuntimeControl) => Promise<void>;

function sortMembers(members: TeammateRecord[]): TeammateRecord[] {
  return [...members].sort((left, right) => left.name.localeCompare(right.name));
}

export class TeammateManager {
  private readonly configPath: string;
  private readonly runtimeControls = new Map<string, TeammateRuntimeControl>();

  constructor(
    readonly teamDir: string,
    private readonly messageBus: MessageBus,
    private readonly leadName: "lead" = "lead",
  ) {
    fs.mkdirSync(this.teamDir, { recursive: true });
    this.configPath = path.join(this.teamDir, "config.json");
    this.ensureConfig();
    this.messageBus.ensureInbox(this.leadName);
    this.resetEphemeralStatuses();
  }

  getLeadName(): "lead" {
    return this.leadName;
  }

  private defaultConfig(): TeamConfig {
    return {
      version: 1,
      leadName: this.leadName,
      members: [],
    };
  }

  private ensureConfig(): void {
    if (fs.existsSync(this.configPath)) {
      return;
    }

    fs.writeFileSync(this.configPath, `${JSON.stringify(this.defaultConfig(), null, 2)}\n`, "utf8");
  }

  private loadConfig(): TeamConfig {
    this.ensureConfig();
    try {
      const content = fs.readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(content) as Partial<TeamConfig>;
      return {
        version: 1,
        leadName: this.leadName,
        members: Array.isArray(parsed.members) ? sortMembers(parsed.members as TeammateRecord[]) : [],
      };
    } catch {
      return this.defaultConfig();
    }
  }

  private saveConfig(config: TeamConfig): void {
    const normalized: TeamConfig = {
      version: 1,
      leadName: this.leadName,
      members: sortMembers(config.members),
    };
    fs.writeFileSync(this.configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  }

  private resetEphemeralStatuses(): void {
    const config = this.loadConfig();
    let changed = false;

    for (const member of config.members) {
      if (member.status !== "stopped") {
        member.status = "stopped";
        changed = true;
      }
    }

    if (changed) {
      this.saveConfig(config);
    }
  }

  private createRuntimeState(name: string, role: string): TeammateRuntimeState {
    return {
      name,
      role,
      chatHistory: [],
      turnCount: 0,
      launchedAt: Date.now(),
      roundsSinceTask: 0,
      compactCount: 0,
    };
  }

  listMembers(): TeammateRecord[] {
    return this.loadConfig().members;
  }

  getMember(name: string): TeammateRecord | undefined {
    return this.listMembers().find((member) => member.name === name);
  }

  ensureMember(name: string, role: string): TeammateRecord {
    const now = new Date().toISOString();
    const config = this.loadConfig();
    const existing = config.members.find((member) => member.name === name);

    if (existing) {
      existing.role = role;
      existing.lastActiveAt = now;
      existing.lastError = undefined;
      if (existing.status === "error" || existing.status === "stopped") {
        existing.status = "idle";
      }
      this.saveConfig(config);
      this.messageBus.ensureInbox(name);
      return existing;
    }

    const member: TeammateRecord = {
      name,
      role,
      status: "idle",
      createdAt: now,
      lastActiveAt: now,
    };

    config.members.push(member);
    this.saveConfig(config);
    this.messageBus.ensureInbox(name);
    return member;
  }

  setStatus(name: string, status: TeamMemberStatus, lastError?: string): void {
    const config = this.loadConfig();
    const member = config.members.find((entry) => entry.name === name);
    if (!member) {
      return;
    }

    member.status = status;
    member.lastActiveAt = new Date().toISOString();
    if (lastError) {
      member.lastError = lastError;
    } else if (status !== "error") {
      member.lastError = undefined;
    }

    this.saveConfig(config);
  }

  markWorking(name: string): void {
    this.setStatus(name, "working");
  }

  markIdle(name: string): void {
    this.setStatus(name, "idle");
  }

  markStopped(name: string): void {
    this.setStatus(name, "stopped");
  }

  markError(name: string, message: string): void {
    this.setStatus(name, "error", message);
  }

  isRunning(name: string): boolean {
    return Boolean(this.runtimeControls.get(name)?.running);
  }

  startRuntime(name: string, role: string, runner: RuntimeRunner): { started: boolean; control: TeammateRuntimeControl } {
    const current = this.runtimeControls.get(name);
    if (current?.running) {
      return { started: false, control: current };
    }

    const control: TeammateRuntimeControl = {
      name,
      role,
      stopRequested: false,
      waiters: new Set(),
      state: this.createRuntimeState(name, role),
    };
    this.runtimeControls.set(name, control);

    control.running = Promise.resolve()
      .then(() => runner(control))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.markError(name, message);
        this.messageBus.send({
          from: name,
          to: this.leadName,
          type: "message",
          content: `Teammate ${name} failed: ${message}`,
        });
      })
      .finally(() => {
        control.running = undefined;
        control.waiters.clear();
        const currentMember = this.getMember(name);
        if (currentMember && currentMember.status !== "error") {
          this.markStopped(name);
        }
      });

    return { started: true, control };
  }

  wake(name: string): void {
    const control = this.runtimeControls.get(name);
    if (!control) {
      return;
    }

    const waiters = [...control.waiters];
    control.waiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  async waitForWake(control: TeammateRuntimeControl): Promise<void> {
    if (control.stopRequested || this.messageBus.inboxSize(control.name) > 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      control.waiters.add(resolve);
    });
  }

  requestStop(name: string): boolean {
    const control = this.runtimeControls.get(name);
    if (!control) {
      this.markStopped(name);
      return false;
    }

    control.stopRequested = true;
    this.wake(name);
    return true;
  }

  shouldStop(control: TeammateRuntimeControl): boolean {
    return control.stopRequested;
  }

  formatTeamStatus(): string {
    const members = this.listMembers();
    if (members.length === 0) {
      return `team_dir ${this.teamDir}\n(no teammates)`;
    }

    return [
      `team_dir ${this.teamDir}`,
      ...members.map((member) => {
        const inboxSize = this.messageBus.inboxSize(member.name);
        const errorSuffix = member.lastError ? ` error=${member.lastError}` : "";
        return `- ${member.name} [${member.status}] role=${member.role} inbox=${inboxSize} last_active=${member.lastActiveAt}${errorSuffix}`;
      }),
    ].join("\n");
  }
}
