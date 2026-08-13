export type ToolArgs = Record<string, unknown>;
export type ResponseInputItem = Record<string, unknown>;
export type ChatMessage = Record<string, unknown>;

export type ImageAttachment = {
  path: string;
  mimeType: string;
  base64Data: string;
};

/**
 * 工具执行的结构化附加结果。
 *
 * 模型只看 `output` 那段文本；这里的内容是给 UI 用的，不进对话上下文。
 */
export type ToolResultDetails = {
  /** 展示用 diff：带行号、只保留改动附近的上下文 */
  diff?: string;
  /** 标准 unified patch，可直接 `git apply` */
  patch?: string;
  /** 新文件里第一处改动的行号 */
  firstChangedLine?: number;
};

/** 工具执行结果。返回裸字符串时等价于 `{ output }`。 */
export type ToolResult = {
  output: string;
  details?: ToolResultDetails;
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
  // 整个会话的累计 token 用量（跨所有轮次，不随单轮重置）。
  // 旧 session 快照可能没有此字段，读取处需做兜底。
  cumulativeUsage?: TokenUsage;
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
  // Legacy USD total kept for backward-compatible session snapshots.
  cost: number;
  // Native provider costs keyed by billing currency. New usage records use this
  // map so CNY-priced DeepSeek calls are never mislabeled or summed as USD.
  costs?: Partial<Record<"USD" | "CNY", number>>;
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
  // `details` 携带工具自己算出的结构化结果（目前是 edit_file 的 diff/patch）。
  // 让工具把 diff 交出来，UI 就不必再从 args 反推改动位置 —— 反推在多处编辑、
  // 模糊匹配、CRLF 文件上都会算错。
  pushTool(name: string, args: ToolArgs, result: string, details?: ToolResultDetails): void;
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
