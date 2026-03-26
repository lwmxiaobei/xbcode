import fs from "node:fs";
import path from "node:path";

import type { MailboxMessage, MailboxMessageType } from "./team-types.js";

type SendMessageInput = {
  from: string;
  to: string;
  content: string;
  type?: MailboxMessageType;
  id?: string;
  timestamp?: string;
};

function normalizeMailboxName(name: string): string {
  const normalized = name.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`Invalid mailbox name: ${name}`);
  }
  return normalized;
}

function isMailboxMessage(value: unknown): value is MailboxMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<MailboxMessage>;
  return (
    typeof candidate.id === "string"
    && typeof candidate.type === "string"
    && typeof candidate.from === "string"
    && typeof candidate.to === "string"
    && typeof candidate.content === "string"
    && typeof candidate.timestamp === "string"
  );
}

function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function renderInboxPrompt(messages: MailboxMessage[]): string {
  const payload = messages.map(({ from, type, content, timestamp }) => ({
    from,
    type,
    content,
    timestamp,
  }));

  return `<inbox>\n${JSON.stringify(payload, null, 2)}\n</inbox>`;
}

export function formatMailboxMessages(messages: MailboxMessage[]): string {
  if (messages.length === 0) {
    return "(empty inbox)";
  }

  return messages
    .map((message) => `[${message.timestamp}] ${message.from} -> ${message.to} (${message.type})\n${message.content}`)
    .join("\n\n");
}

export class MessageBus {
  readonly teamDir: string;
  readonly inboxDir: string;

  constructor(teamDir: string) {
    this.teamDir = teamDir;
    this.inboxDir = path.join(teamDir, "inbox");
    fs.mkdirSync(this.inboxDir, { recursive: true });
  }

  inboxPath(name: string): string {
    return path.join(this.inboxDir, `${normalizeMailboxName(name)}.jsonl`);
  }

  ensureInbox(name: string): void {
    const inboxPath = this.inboxPath(name);
    fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
    if (!fs.existsSync(inboxPath)) {
      fs.writeFileSync(inboxPath, "", "utf8");
    }
  }

  send(input: SendMessageInput): MailboxMessage {
    const message: MailboxMessage = {
      id: input.id ?? createMessageId(),
      type: input.type ?? "message",
      from: normalizeMailboxName(input.from),
      to: normalizeMailboxName(input.to),
      content: input.content,
      timestamp: input.timestamp ?? new Date().toISOString(),
    };

    this.ensureInbox(message.to);
    fs.appendFileSync(this.inboxPath(message.to), `${JSON.stringify(message)}\n`, "utf8");
    return message;
  }

  readInbox(name: string): MailboxMessage[] {
    this.ensureInbox(name);
    const content = fs.readFileSync(this.inboxPath(name), "utf8");
    if (!content.trim()) {
      return [];
    }

    const messages: MailboxMessage[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (isMailboxMessage(parsed)) {
          messages.push(parsed);
        }
      } catch {
        // Ignore malformed lines so one bad record doesn't poison the inbox.
      }
    }
    return messages;
  }

  drainInbox(name: string): MailboxMessage[] {
    const messages = this.readInbox(name);
    fs.writeFileSync(this.inboxPath(name), "", "utf8");
    return messages;
  }

  inboxSize(name: string): number {
    return this.readInbox(name).length;
  }
}
