import type { ChatMessage } from "./types.js";

export type TeamMemberStatus = "working" | "idle" | "stopped" | "error";
export type MailboxMessageType = "message" | "broadcast" | "shutdown_request" | "shutdown_response";

export type TeammateRecord = {
  name: string;
  role: string;
  status: TeamMemberStatus;
  createdAt: string;
  lastActiveAt: string;
  lastError?: string;
};

export type TeamConfig = {
  version: 1;
  leadName: "lead";
  members: TeammateRecord[];
};

export type MailboxMessage = {
  id: string;
  type: MailboxMessageType;
  from: string;
  to: string;
  content: string;
  timestamp: string;
};

export type TeammateRuntimeState = {
  name: string;
  role: string;
  previousResponseId?: string;
  chatHistory: ChatMessage[];
  turnCount: number;
  launchedAt: number;
  roundsSinceTask: number;
  compactCount: number;
};
