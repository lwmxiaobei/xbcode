import type { ToolArgs, UiBridge, UserChoiceQuestion, UserChoiceOption } from "../types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export function parseUserChoiceQuestions(raw: unknown): UserChoiceQuestion[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: UserChoiceQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const header = String(obj.header ?? "").trim();
    const question = String(obj.question ?? "").trim();
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options: UserChoiceOption[] = [];
    for (const opt of rawOptions) {
      if (!opt || typeof opt !== "object") {
        continue;
      }
      const o = opt as Record<string, unknown>;
      const label = String(o.label ?? "").trim();
      if (!label) {
        continue;
      }
      const description = o.description != null ? String(o.description) : undefined;
      options.push(description ? { label, description } : { label });
    }
    if (!question || options.length === 0) {
      continue;
    }
    questions.push({ header, question, multiSelect: Boolean(obj.multiSelect), options });
  }
  return questions;
}

export function formatUserChoiceResult(questions: UserChoiceQuestion[], answers: string[][]): string {
  const blocks = questions.map((question, index) => {
    const selected = (answers[index] ?? []).filter((label) => label.trim().length > 0);
    const selectedText = selected.length > 0 ? selected.join(", ") : "(no selection)";
    return `Q: ${question.question}\nSelected: ${selectedText}`;
  });
  return `The user answered the question(s):\n\n${blocks.join("\n\n")}`;
}

export async function runAskUserQuestion(args: ToolArgs, bridge: UiBridge): Promise<string> {
  const questions = parseUserChoiceQuestions(args.questions);
  if (questions.length === 0) {
    return 'Error: ask_user_question requires a non-empty "questions" array; each question needs a "question" string and at least one option with a "label".';
  }
  const answers = await bridge.requestUserChoice(questions);
  return formatUserChoiceResult(questions, answers);
}
