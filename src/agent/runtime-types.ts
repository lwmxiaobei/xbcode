import type { ImageAttachment, ToolArgs, ToolResult } from "../types.js";

export type RunControl = {
  signal?: AbortSignal;
  /**
   * 当前轮使用的模型 id。工具据此判断能力边界
   * （目前只有 read_file 用它决定要不要把图片真的发出去）。
   */
  model?: string;
  /**
   * 本轮工具产生、待注入对话的图片。
   *
   * 为什么要绕这一圈：工具结果在两种 API 下都只能是纯文本
   * （Chat Completions 的 tool 消息、Responses 的 function_call_output 都不收图），
   * 所以 read_file 读到的图片只能挂在这里，由 agent loop 在提交工具结果之后
   * 追加成一条 user 消息发出去。数组随 run 创建，子代理与主循环互不串台。
   */
  pendingImages?: ImageAttachment[];
};

export type ToolHandler = (args: ToolArgs, control?: RunControl) => Promise<string | ToolResult> | string | ToolResult;
export type ToolHandlerMap = Record<string, ToolHandler>;

export type PreparedToolRuntime = {
  handlers: ToolHandlerMap;
  responseTools: readonly any[];
  chatTools: readonly any[];
};
