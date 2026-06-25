import { wrapApiError } from "../error-log.js";

export class TurnInterruptedError extends Error {
  responseId?: string;
  partialAssistantText?: string;

  constructor(options?: { responseId?: string; partialAssistantText?: string }) {
    super("Turn interrupted by user.");
    this.name = "TurnInterruptedError";
    this.responseId = options?.responseId;
    this.partialAssistantText = options?.partialAssistantText;
  }
}

export function isTurnInterruptedError(error: unknown): error is TurnInterruptedError {
  return error instanceof TurnInterruptedError;
}

export class ResponseStreamError extends Error {
  responseId?: string;
  partialAssistantText?: string;

  constructor(caller: string, error: unknown, options?: { responseId?: string; partialAssistantText?: string }) {
    const wrapped = wrapApiError(caller, error);
    super(wrapped.message, { cause: error });
    this.name = wrapped.name;
    this.responseId = options?.responseId;
    this.partialAssistantText = options?.partialAssistantText;

    const src = wrapped as Error & { status?: number; headers?: unknown; error?: unknown; code?: unknown };
    const dst = this as Error & { status?: number; headers?: unknown; error?: unknown; code?: unknown };
    if (src.status !== undefined) dst.status = src.status;
    if (src.headers !== undefined) dst.headers = src.headers;
    if (src.error !== undefined) dst.error = src.error;
    if (src.code !== undefined) dst.code = src.code;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new TurnInterruptedError();
  }
}
