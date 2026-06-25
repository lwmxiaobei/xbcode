import OpenAI, { APIUserAbortError } from "openai";

import { logApiError, wrapApiError } from "../error-log.js";
import { isTransientNetworkError } from "../http.js";
import { combineAbortSignals, createIdleWatchdog, getStreamIdleTimeoutMs } from "../idle-watchdog.js";
import { CHAT_TOOLS, TOOLS } from "../tools.js";
import type { ChatMessage, ResponseInputItem, TokenUsage, UiBridge } from "../types.js";
import { ResponseStreamError, TurnInterruptedError, throwIfAborted } from "./interrupt.js";
import { cloneResponseReplayItem, extractAssistantTextFromResponseOutput, getMissingAssistantText, getResponseContentKey, normalizeResponseInput } from "./messages.js";
import type { RunControl } from "./runtime-types.js";
import { extractTokenUsage } from "./usage.js";

const STREAM_MAX_RETRIES = 2;
const STREAM_RETRY_DELAYS_MS = [200, 800] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function streamResponse(
  client: OpenAI,
  model: string,
  system: string,
  showThinking: boolean,
  inputItems: ResponseInputItem[] | string,
  previousResponseId: string | undefined,
  bridge: UiBridge,
  tools: readonly any[] = TOOLS,
  control?: RunControl,
  onUsage?: (usage: TokenUsage) => void,
  caller: string = "main",
): Promise<any> {
  throwIfAborted(control?.signal);
  const normalizedInstructions = system.trim() || "You are a helpful coding assistant.";
  const normalizedInput = normalizeResponseInput(inputItems);

  const idleTimeoutMs = getStreamIdleTimeoutMs();

  let attempt = 0;
  // 仅 attempt 0 时为 false。一旦任何字节通过 bridge 推到 UI，就不能再重试，
  // 否则用户会看到同一段文本被重复 append。
  while (true) {
  // 每个 attempt 一个新 watchdog。它的 signal 会和 user signal 合并传给 SDK，
  // 任意一端 abort 都会触发 SDK 取消请求；catch 时通过 `watchdog.triggered`
  // 标志区分"用户 Esc"还是"watchdog 自动 abort"。
  const watchdog = createIdleWatchdog(idleTimeoutMs);
  const requestSignal = combineAbortSignals([control?.signal, watchdog.signal]);

  const stream = client.responses.stream({
    model,
    instructions: normalizedInstructions,
    input: normalizedInput as any,
    // ChatGPT Codex backend is stricter than the public Responses API.
    // `sub2api`'s working probe payload explicitly sends `store: false` for the
    // Codex OAuth path, and the public API also accepts this field, so we set
    // it unconditionally to keep one compatible request shape for both backends.
    store: false,
    previous_response_id: previousResponseId,
    tools: tools as any,
  }, requestSignal ? { signal: requestSignal } : undefined);
  // 请求发出后立刻 arm watchdog。第一个字节最久允许 idleTimeoutMs 出现，
  // 这样"建立 TCP 但服务端完全不发数据"的情况也能被兜住。
  watchdog.reset();

  let responseId: string | undefined;
  let assistantText = "";
  let streamedToBridge = false;
  const streamedFunctionCalls = new Map<string, any>();
  const streamedAssistantContent = new Map<string, string>();

  const emitAssistantDelta = (text: string) => {
    if (!text) return;
    streamedToBridge = true;
    bridge.appendAssistantDelta(text);
  };
  const emitThinkingDelta = (text: string) => {
    if (!text) return;
    streamedToBridge = true;
    bridge.appendThinkingDelta(text);
  };

  /**
   * ChatGPT Codex stream responses are slightly different from the public
   * Responses API as surfaced through the OpenAI SDK:
   * - tool-call items are emitted over SSE events,
   * - but `stream.finalResponse()` can still return `output: []`.
   * We therefore key partial function calls by `output_index` and rebuild the
   * final tool-call list from the stream itself when needed.
   */
  const getFunctionCallKey = (event: any, fallbackIndex?: number): string => {
    if (event?.output_index !== undefined) {
      return String(event.output_index);
    }
    if (event?.item?.call_id) {
      return String(event.item.call_id);
    }
    if (event?.item?.id) {
      return String(event.item.id);
    }
    return String(fallbackIndex ?? streamedFunctionCalls.size);
  };

  try {
    for await (const event of stream as AsyncIterable<any>) {
      // 心跳：任何 SDK 事件都算"流还活着"，包括 reasoning_*.delta 这类
      // 不一定渲染到 UI 的事件。让 UI 能区分"模型在 thinking"和"连接 stall"。
      bridge.noteStreamActivity();
      watchdog.reset();

      if (event.type === "response.created") {
        responseId = String(event.response?.id ?? responseId ?? "");
      }

      if (event.type === "response.output_text.delta") {
        const delta = String(event.delta ?? "");
        assistantText += delta;
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        streamedAssistantContent.set(
          contentKey,
          `${streamedAssistantContent.get(contentKey) ?? ""}${delta}`,
        );
        emitAssistantDelta(delta);
        continue;
      }

      /**
       * 有些 Responses 后端不会先发 `output_text.delta`，而是直接先把一个完整或
       * 半完整的 output_text part 塞进 `content_part.added/done`。如果不消费这些
       * 事件，UI 就会出现“只有工具调用，没有 assistant 文本”。
       */
      if (event.type === "response.content_part.added" && event.part?.type === "output_text") {
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        const nextText = String(event.part?.text ?? "");
        const emittedText = streamedAssistantContent.get(contentKey) ?? "";
        const missingText = nextText.startsWith(emittedText) ? nextText.slice(emittedText.length) : nextText;

        if (missingText) {
          assistantText += missingText;
          emitAssistantDelta(missingText);
        }
        streamedAssistantContent.set(contentKey, nextText);
        continue;
      }

      if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
        const key = getFunctionCallKey(event);
        streamedFunctionCalls.set(key, {
          ...cloneResponseReplayItem(event.item),
          arguments: String(event.item?.arguments ?? ""),
        });
        bridge.finalizeStreaming();
        continue;
      }

      if (event.type === "response.function_call_arguments.delta") {
        const key = getFunctionCallKey(event);
        const current = streamedFunctionCalls.get(key);
        if (current) {
          current.arguments = `${String(current.arguments ?? "")}${String(event.delta ?? "")}`;
          streamedFunctionCalls.set(key, current);
        }
        continue;
      }

      if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        const key = getFunctionCallKey(event);
        const current = streamedFunctionCalls.get(key) ?? {};
        streamedFunctionCalls.set(key, {
          ...current,
          ...cloneResponseReplayItem(event.item),
          arguments: String(event.item?.arguments ?? current.arguments ?? ""),
        });
        continue;
      }

      if (event.type === "response.content_part.done" && event.part?.type === "output_text") {
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        const nextText = String(event.part?.text ?? "");
        const emittedText = streamedAssistantContent.get(contentKey) ?? "";
        const missingText = nextText.startsWith(emittedText) ? nextText.slice(emittedText.length) : nextText;

        if (missingText) {
          assistantText += missingText;
          emitAssistantDelta(missingText);
        }
        streamedAssistantContent.set(contentKey, nextText);
        continue;
      }

      if (event.type === "response.output_text.done") {
        const contentKey = getResponseContentKey(event.output_index, event.content_index);
        const nextText = String(event.text ?? "");
        const emittedText = streamedAssistantContent.get(contentKey) ?? "";
        const missingText = nextText.startsWith(emittedText) ? nextText.slice(emittedText.length) : nextText;

        if (missingText) {
          assistantText += missingText;
          emitAssistantDelta(missingText);
        }
        streamedAssistantContent.set(contentKey, nextText);
        continue;
      }

      if (showThinking && ["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type)) {
        emitThinkingDelta(String(event.delta ?? ""));
        continue;
      }
    }

    const response = await stream.finalResponse();
    watchdog.disarm();
    if (response.usage) {
      onUsage?.(extractTokenUsage(response.usage, model));
    }
    const sdkOutput = Array.isArray(response.output) ? response.output : [];
    const recoveredAssistantText = extractAssistantTextFromResponseOutput(sdkOutput);
    const missingAssistantText = getMissingAssistantText(assistantText, recoveredAssistantText);

    /**
     * 这里必须在 finalize 之前补 UI：
     * - `appendAssistantDelta()` 依赖当前正在流式渲染的 message id；
     * - 一旦先 finalize，就只能新建一条 assistant 消息，文本会和前面的片段断开；
     * - 先补齐缺失尾巴，再 finalize，才能最大程度保留“同一条回答”的连续性。
     */
    if (missingAssistantText) {
      emitAssistantDelta(missingAssistantText);
      assistantText = `${assistantText}${missingAssistantText}`;
    }
    bridge.finalizeStreaming();

    /**
     * Preserve SDK output when present, but patch in a synthetic fallback for
     * Codex OAuth streams whose final response omits the items we already saw on
     * the wire.
     */
    if (sdkOutput.length > 0) {
      return response;
    }

    const rebuiltOutput: any[] = [];
    if (assistantText) {
      rebuiltOutput.push({
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: assistantText,
          },
        ],
      });
    }

    for (const item of streamedFunctionCalls.values()) {
      rebuiltOutput.push(item);
    }

    return {
      ...response,
      output: rebuiltOutput,
    };
  } catch (error) {
    watchdog.disarm();
    bridge.finalizeStreaming();
    // 必须在 user-abort 判断之前处理 watchdog 触发：watchdog 也走的是
    // AbortController，SDK 会抛 APIUserAbortError，但语义上不是用户主动停。
    if (watchdog.triggered && !control?.signal?.aborted) {
      // 已经流出过字节就不重试——重试会让 UI 出现重复段。
      // 这种情况只能交给上层（最终 throw 一个明确的 stalled error）。
      if (attempt < STREAM_MAX_RETRIES && !streamedToBridge) {
        await sleep(STREAM_RETRY_DELAYS_MS[attempt] ?? STREAM_RETRY_DELAYS_MS[STREAM_RETRY_DELAYS_MS.length - 1]);
        attempt += 1;
        continue;
      }
      const stalledError = new Error(
        `Stream stalled: no SSE event for ${idleTimeoutMs}ms (set STREAM_IDLE_TIMEOUT_MS=0 to disable, or a larger value to tolerate slower reasoning models).`,
      );
      logApiError(caller, stalledError, {
        api: "responses",
        model,
        previousResponseId,
        toolCount: tools.length,
        inputItemCount: normalizedInput.length,
        inputCharCount: JSON.stringify(normalizedInput).length,
        showThinking,
        idleTimeoutMs,
        streamedToBridge,
      });
      throw stalledError;
    }
    if (error instanceof APIUserAbortError || control?.signal?.aborted) {
      throw new TurnInterruptedError({
        responseId,
        partialAssistantText: assistantText || undefined,
      });
    }
    // 仅当 transient 网络错误且 UI 还没收到任何内容时才重试，避免重复输出。
    if (
      attempt < STREAM_MAX_RETRIES &&
      !streamedToBridge &&
      isTransientNetworkError(error)
    ) {
      await sleep(STREAM_RETRY_DELAYS_MS[attempt] ?? STREAM_RETRY_DELAYS_MS[STREAM_RETRY_DELAYS_MS.length - 1]);
      attempt += 1;
      continue;
    }
    logApiError(caller, error, {
      api: "responses",
      model,
      previousResponseId,
      toolCount: tools.length,
      inputItemCount: normalizedInput.length,
      inputCharCount: JSON.stringify(normalizedInput).length,
      showThinking,
    });
    throw new ResponseStreamError(caller, error, {
      responseId,
      partialAssistantText: assistantText || undefined,
    });
  }
  }
}

export async function streamChatCompletion(
  client: OpenAI,
  model: string,
  system: string,
  history: ChatMessage[],
  bridge: UiBridge,
  tools: readonly any[] = CHAT_TOOLS,
  showThinking: boolean = false,
  control?: RunControl,
  onUsage?: (usage: TokenUsage) => void,
  caller: string = "main",
): Promise<{ content: string | null; tool_calls: any[]; reasoning_content?: string }> {
  throwIfAborted(control?.signal);

  const createParams: any = {
    model,
    messages: [{ role: "system", content: system }, ...history] as any,
    tools: tools as any,
    tool_choice: "auto",
    stream: true,
    stream_options: { include_usage: true },
  };
  if (showThinking) {
    createParams.thinking = { type: "enabled" };
  }

  const idleTimeoutMs = getStreamIdleTimeoutMs();

  let attempt = 0;
  while (true) {
    let content = "";
    let reasoningContent = "";
    let streamedToBridge = false;
    // 每次 API 请求只计一次 usage。OpenAI 标准只在最后一个 chunk 给 usage，
    // 但 GLM/火山引擎等兼容端点常在每个 chunk 都带（且多为累积值），
    // 若逐 chunk 累加会把同一请求的 input 重复计入、token 数暴涨。
    // 这里只保留最后一次见到的 usage，循环结束后再 onUsage 一次。
    let lastUsage: any;
    const toolCallBuffers: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};

    // 每个 attempt 一个新 watchdog。和 streamResponse 同样的策略：
    // SDK 收到 abort 后会抛 APIUserAbortError，catch 时 watchdog.triggered 优先判断。
    const watchdog = createIdleWatchdog(idleTimeoutMs);
    const requestSignal = combineAbortSignals([control?.signal, watchdog.signal]);

    let stream: any;
    try {
      // 建立连接前 arm watchdog —— 兜住"connect 完成但服务端永不发任何 chunk"。
      watchdog.reset();
      stream = await client.chat.completions.create(
        createParams as any,
        requestSignal ? { signal: requestSignal } : undefined,
      ) as any;
    } catch (error) {
      watchdog.disarm();
      if (watchdog.triggered && !control?.signal?.aborted) {
        if (attempt < STREAM_MAX_RETRIES) {
          await sleep(STREAM_RETRY_DELAYS_MS[attempt] ?? STREAM_RETRY_DELAYS_MS[STREAM_RETRY_DELAYS_MS.length - 1]);
          attempt += 1;
          continue;
        }
        throw new Error(`Stream stalled before first event: no response for ${idleTimeoutMs}ms`);
      }
      if (error instanceof APIUserAbortError || control?.signal?.aborted) {
        throw new TurnInterruptedError({});
      }
      if (
        attempt < STREAM_MAX_RETRIES &&
        isTransientNetworkError(error)
      ) {
        await sleep(STREAM_RETRY_DELAYS_MS[attempt] ?? STREAM_RETRY_DELAYS_MS[STREAM_RETRY_DELAYS_MS.length - 1]);
        attempt += 1;
        continue;
      }
      logApiError(caller, error, {
        api: "chat-completions",
        model,
        toolCount: tools.length,
        inputItemCount: history.length,
        inputCharCount: JSON.stringify(history).length,
        showThinking,
      });
      throw wrapApiError(caller, error);
    }

    try {
      for await (const chunk of stream) {
        // 心跳：每个 chunk（即使是 usage-only 或空 delta）都算"流还活着"。
        // 关键场景：mimo 这类 reasoning 模型在 thinking 阶段会持续吐
        // `reasoning_content` chunk，但用户没开 SHOW_THINKING 时 UI 不渲染——
        // 没有心跳的话，外部就以为"卡死"了。
        bridge.noteStreamActivity();
        watchdog.reset();

        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
        const delta = chunk.choices?.[0]?.delta as any;
        if (!delta) continue;

        if (showThinking && delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          streamedToBridge = true;
          bridge.appendThinkingDelta(delta.reasoning_content);
        }

        if (delta.content) {
          content += delta.content;
          streamedToBridge = true;
          bridge.appendAssistantDelta(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallBuffers[tc.index]) {
              toolCallBuffers[tc.index] = {
                id: tc.id ?? "",
                type: "function" as const,
                function: { name: "", arguments: "" },
              };
            }
            const buf = toolCallBuffers[tc.index];
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.function.name += tc.function.name;
            if (tc.function?.arguments) buf.function.arguments += tc.function.arguments;
          }
        }
      }

      watchdog.disarm();
      bridge.finalizeStreaming();

      // 整个请求结束后，用最后一次 usage 计一次费用（避免逐 chunk 重复累加）。
      if (lastUsage) {
        onUsage?.(extractTokenUsage(lastUsage, model));
      }

      const toolCalls = Object.keys(toolCallBuffers)
        .sort((left, right) => Number(left) - Number(right))
        .map((key) => toolCallBuffers[Number(key)]);

      return {
        content: content || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : [],
        reasoning_content: reasoningContent || undefined,
      };
    } catch (error) {
      watchdog.disarm();
      bridge.finalizeStreaming();
      // watchdog 优先：和 streamResponse 同样的理由。
      if (watchdog.triggered && !control?.signal?.aborted) {
        if (attempt < STREAM_MAX_RETRIES && !streamedToBridge) {
          await sleep(STREAM_RETRY_DELAYS_MS[attempt] ?? STREAM_RETRY_DELAYS_MS[STREAM_RETRY_DELAYS_MS.length - 1]);
          attempt += 1;
          continue;
        }
        const stalledError = new Error(
          `Stream stalled: no SSE event for ${idleTimeoutMs}ms (set STREAM_IDLE_TIMEOUT_MS=0 to disable, or a larger value to tolerate slower reasoning models).`,
        );
        logApiError(caller, stalledError, {
          api: "chat-completions",
          model,
          toolCount: tools.length,
          inputItemCount: history.length,
          inputCharCount: JSON.stringify(history).length,
          showThinking,
          idleTimeoutMs,
          streamedToBridge,
        });
        throw stalledError;
      }
      if (error instanceof APIUserAbortError || control?.signal?.aborted) {
        throw new TurnInterruptedError({
          partialAssistantText: content || undefined,
        });
      }
      if (
        attempt < STREAM_MAX_RETRIES &&
        !streamedToBridge &&
        isTransientNetworkError(error)
      ) {
        await sleep(STREAM_RETRY_DELAYS_MS[attempt] ?? STREAM_RETRY_DELAYS_MS[STREAM_RETRY_DELAYS_MS.length - 1]);
        attempt += 1;
        continue;
      }
      logApiError(caller, error, {
        api: "chat-completions",
        model,
        toolCount: tools.length,
        inputItemCount: history.length,
        inputCharCount: JSON.stringify(history).length,
        showThinking,
      });
      throw wrapApiError(caller, error);
    }
  }
}
