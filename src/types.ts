export type ToolArgs = Record<string, unknown>;
export type ResponseInputItem = Record<string, unknown>;
export type ChatMessage = Record<string, unknown>;

export type AgentState = {
  previousResponseId?: string;
  chatHistory: ChatMessage[];
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

export type UiBridge = {
  appendAssistantDelta(delta: string): void;
  appendThinkingDelta(delta: string): void;
  finalizeStreaming(): void;
  pushAssistant(text: string): void;
  pushTool(name: string, args: ToolArgs, result: string): void;
};
