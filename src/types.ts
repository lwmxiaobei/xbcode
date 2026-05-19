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

export type UiBridge = {
  appendAssistantDelta(delta: string): void;
  appendThinkingDelta(delta: string): void;
  finalizeStreaming(): void;
  pushAssistant(text: string): void;
  pushTool(name: string, args: ToolArgs, result: string): void;
  updateUsage(usage: TokenUsage): void;
};
