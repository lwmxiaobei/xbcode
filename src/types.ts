export type ToolArgs = Record<string, unknown>;
export type ResponseInputItem = Record<string, unknown>;
export type ChatMessage = Record<string, unknown>;

export type ImageAttachment = {
  path: string;
  mimeType: string;
  base64Data: string;
};

export type GoalStatus = "active" | "paused" | "blocked" | "budget_limited" | "complete";

export type GoalState = {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
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
  goal?: GoalState;
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

// 模型通过 `ask_user_question` 工具向用户发起的一道选择题。
// 对齐 Claude Code 的 AskUserQuestion：每题 2-4 个选项，可单选或多选。
export type UserChoiceOption = {
  label: string;
  description?: string;
};

export type UserChoiceQuestion = {
  header: string;
  question: string;
  multiSelect?: boolean;
  options: UserChoiceOption[];
};

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
  // 模型主动发问的 human-in-the-loop：渲染交互式选择菜单并阻塞，等待用户作答。
  // 返回值与 `questions` 一一对应，每项是该题被选中的选项 label 列表（多选可多个）。
  // 自治 agent（子代理 / teammate）无人可问，实现应返回确定性默认值（各题首选项）。
  requestUserChoice(questions: UserChoiceQuestion[]): Promise<string[][]>;
};
