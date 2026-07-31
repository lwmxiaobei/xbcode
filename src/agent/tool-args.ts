import type { ToolArgs } from "../types.js";

type ToolArgType = "string" | "integer" | "array";

type ToolArgSpec = {
  type: ToolArgType;
  required?: boolean;
  nonEmpty?: boolean;
  enum?: readonly string[];
  itemType?: ToolArgType;
};

type ToolArgsSpec = {
  fields: Record<string, ToolArgSpec>;
  requireAny?: readonly string[];
};

const SIDE_EFFECT_TOOL_ARGS: Record<string, ToolArgsSpec> = {
  bash: {
    fields: {
      command: { type: "string", required: true, nonEmpty: true },
    },
  },
  write_file: {
    fields: {
      path: { type: "string", required: true, nonEmpty: true },
      content: { type: "string", required: true },
    },
  },
  edit_file: {
    fields: {
      path: { type: "string", required: true, nonEmpty: true },
      old_text: { type: "string", required: true, nonEmpty: true },
      new_text: { type: "string", required: true },
    },
  },
  task_create: {
    fields: {
      subject: { type: "string", required: true, nonEmpty: true },
      description: { type: "string" },
      owner: { type: "string" },
      assignee: { type: "string" },
    },
  },
  task_update: {
    fields: {
      task_id: { type: "integer", required: true },
      status: { type: "string", enum: ["pending", "assigned", "in_progress", "blocked", "completed", "failed"] },
      blocked_by: { type: "array", itemType: "integer" },
      blocks: { type: "array", itemType: "integer" },
      assignee: { type: "string" },
      result_summary: { type: "string" },
      blocked_reason: { type: "string" },
    },
    requireAny: ["status", "blocked_by", "blocks", "assignee", "result_summary", "blocked_reason"],
  },
  task_assign: {
    fields: {
      task_id: { type: "integer", required: true },
      assignee: { type: "string", required: true, nonEmpty: true },
    },
  },
  task_complete: {
    fields: {
      task_id: { type: "integer", required: true },
      result_summary: { type: "string", required: true, nonEmpty: true },
    },
  },
  task_block: {
    fields: {
      task_id: { type: "integer", required: true },
      reason: { type: "string", required: true, nonEmpty: true },
    },
  },
  task_fail: {
    fields: {
      task_id: { type: "integer", required: true },
      reason: { type: "string", required: true, nonEmpty: true },
    },
  },
  create_goal: {
    fields: {
      objective: { type: "string", required: true, nonEmpty: true },
      token_budget: { type: "integer" },
    },
  },
  update_goal: {
    fields: {
      status: { type: "string", required: true, enum: ["complete", "blocked"] },
    },
  },
  subagent: {
    fields: {
      description: { type: "string", required: true, nonEmpty: true },
      subagent_type: { type: "string", enum: ["general-purpose", "explore"] },
    },
  },
  message_send: {
    fields: {
      to: { type: "string", required: true, nonEmpty: true },
      content: { type: "string", required: true, nonEmpty: true },
    },
  },
  teammate_spawn: {
    fields: {
      name: { type: "string", required: true, nonEmpty: true },
      role: { type: "string", required: true, nonEmpty: true },
      prompt: { type: "string", required: true, nonEmpty: true },
    },
  },
  teammate_shutdown: {
    fields: {
      name: { type: "string" },
    },
  },
};

export type ToolArgsParseResult =
  | { ok: true; args: ToolArgs }
  | { ok: false; args: ToolArgs; error: string };

export function parseToolArgs(value: string): ToolArgsParseResult {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, args: {}, error: "expected a JSON object" };
    }
    return { ok: true, args: parsed as ToolArgs };
  } catch {
    return {
      ok: false,
      args: {},
      error: "malformed JSON, possibly truncated by the model or provider; retry with a smaller complete call, and build large files incrementally",
    };
  }
}

export function invalidToolArguments(name: string, reason: string): string {
  return `Error: Invalid arguments for ${name}: ${reason}. The tool was not executed.`;
}

function hasValue(args: ToolArgs, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(args, field) && args[field] !== undefined && args[field] !== null;
}

function validateType(field: string, value: unknown, spec: ToolArgSpec): string | null {
  if (spec.type === "string") {
    if (typeof value !== "string") {
      return `${field} must be a string`;
    }
    if (spec.nonEmpty && value.trim() === "") {
      return `${field} must be a non-empty string`;
    }
    if (spec.enum && !spec.enum.includes(value)) {
      return `${field} must be one of ${spec.enum.join(", ")}`;
    }
    return null;
  }

  if (spec.type === "integer") {
    if (!Number.isInteger(value)) {
      return `${field} must be an integer`;
    }
    return null;
  }

  if (!Array.isArray(value)) {
    return `${field} must be an array`;
  }
  if (spec.itemType === "integer" && value.some((item) => !Number.isInteger(item))) {
    return `${field} must contain only integers`;
  }
  return null;
}

function missingFieldReason(field: string, spec: ToolArgSpec): string {
  if (spec.type === "string") {
    return spec.nonEmpty ? `${field} must be a non-empty string` : `${field} must be a string`;
  }
  if (spec.type === "integer") {
    return `${field} must be an integer`;
  }
  return `${field} must be an array`;
}

export function validateToolArgs(name: string, args: ToolArgs): string | null {
  const spec = SIDE_EFFECT_TOOL_ARGS[name];
  if (!spec) {
    return null;
  }

  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    if (!hasValue(args, field)) {
      if (fieldSpec.required) {
        return invalidToolArguments(name, missingFieldReason(field, fieldSpec));
      }
      continue;
    }

    const fieldError = validateType(field, args[field], fieldSpec);
    if (fieldError) {
      return invalidToolArguments(name, fieldError);
    }
  }

  if (spec.requireAny && !spec.requireAny.some((field) => hasValue(args, field))) {
    return invalidToolArguments(name, `at least one of ${spec.requireAny.join(", ")} is required`);
  }

  return null;
}
