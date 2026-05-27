export type ToolArgs = Record<string, unknown>;
export type ResponseInputItem = Record<string, unknown>;
export type ChatMessage = Record<string, unknown>;

export type ImageAttachment = {
  path: string;
  mimeType: string;
  base64Data: string;
};

export type AgentState = {
  sessionId: string;
  previousResponseId?: string;
  responseHistory: ResponseInputItem[];
  chatHistory: ChatMessage[];
  pendingCompactedContext?: string;
  turnCount: number;
  launchedAt: number;
  roundsSinceTask: number;
  compactCount: number;
};

export type DiffLine = {
  text: string;
  color: string;
};

export type UiMessage = {
  id: string;
  kind: "system" | "user" | "assistant" | "tool" | "thinking" | "error";
  title?: string;
  subtitle?: string;
  text: string;
  diffLines?: DiffLine[];
  collapsed?: boolean;
};

export type PersistedUiMessage = {
  kind: UiMessage["kind"];
  title?: string;
  subtitle?: string;
  text: string;
  diffLines?: DiffLine[];
  collapsed?: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
};

export type ToolApprovalDecision = "approved" | "rejected";

export type UiBridge = {
  appendAssistantDelta(delta: string): void;
  appendThinkingDelta(delta: string): void;
  finalizeStreaming(): void;
  pushAssistant(text: string): void;
  pushTool(name: string, args: ToolArgs, result: string): void;
  updateUsage(usage: TokenUsage): void;
  // Stream heartbeat: the agent loop calls this every time the SDK yields ANY
  // stream event — including reasoning chunks we choose not to render. The UI
  // uses it to distinguish "model is still talking but quietly" from "connection
  // has stalled" without showing user-visible content for non-displayed events.
  noteStreamActivity(): void;
  // Human-in-the-loop gate: the loop calls this before running a mutating tool.
  // Implementations may auto-approve (e.g. sub-agents) or prompt the user.
  requestToolApproval(name: string, args: ToolArgs): Promise<ToolApprovalDecision>;
};
