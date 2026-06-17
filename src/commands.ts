/**
 * Normalize built-in slash commands into the format consumed by the submit
 * handler.
 *
 * Why this exists:
 * - The CLI needs one authoritative decision point for "is this a built-in
 *   command or should it fall through to skills/user input?".
 * - Some commands intentionally keep their trailing arguments because later
 *   dispatch logic needs the provider/model name, for example `/login openai`.
 * - Extracting this logic into a small module makes regression testing
 *   possible without importing the full TUI entrypoint.
 */
export function normalizeCommand(inputValue: string): string | null {
  const trimmed = inputValue.trim();
  if (!trimmed) {
    return null;
  }

  /**
   * Built-in commands must be explicitly prefixed with "/".
   *
   * Why this matters:
   * - Normal chat text can legitimately start with words like "provider",
   *   "login", or "logout".
   * - Treating bare text as a command makes Chinese/English mixed input easy to
   *   misclassify because there may be no whitespace boundary after the first
   *   English token.
   * - The submit layer already handles bare "q"/"exit" separately, so command
   *   normalization should stay strict here.
   */
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  const parts = withoutSlash.split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const args = withoutSlash.slice(parts[0]?.length ?? 0).trim();
  const normalizedArgs = cmd === "goal" ? args : args.toLowerCase();
  const normalized = normalizedArgs ? `${cmd} ${normalizedArgs}` : cmd;

  switch (cmd) {
    case "help":
    case "status":
    case "usage":
    case "mcp":
    case "team":
    case "inbox":
    case "compact":
    case "new":
    case "resume":
    case "goal":
    case "exit":
      return normalized;
    case "provider":
    case "model":
    case "login":
    case "logout":
      return normalized;
    case "quit":
      return "exit";
    default:
      return null;
  }
}

/**
 * Decide whether a given submission would start an agent turn and therefore
 * requires the user to have explicitly selected a model first.
 *
 * Why this exists:
 * - The CLI can intentionally enter the main UI without a chosen model when
 *   the picker is dismissed, but plain chat input must still be blocked.
 * - Built-in commands such as `/help`, `/model`, or `/resume` should continue
 *   to work because they do not directly open a model-backed turn.
 * - Skill slash commands are special: they are slash-prefixed, but they do run
 *   an agent turn, so the caller passes that knowledge explicitly.
 */
export function submissionNeedsSelectedModel(inputValue: string, isSkillSlashInvocation = false): boolean {
  const trimmed = inputValue.trim();
  if (!trimmed) {
    return false;
  }

  if (["q", "exit"].includes(trimmed.toLowerCase())) {
    return false;
  }

  if (normalizeCommand(trimmed)) {
    return false;
  }

  if (isSkillSlashInvocation) {
    return true;
  }

  return !trimmed.startsWith("/");
}

export type StartupCommand =
  | { kind: "default" }
  | { kind: "resume"; sessionId?: string };

/**
 * Parse process argv into the minimal startup commands supported by the CLI.
 *
 * Why this exists:
 * - Slash commands run after the TUI mounts, but `xbcode resume <id>` needs to
 *   restore state before the first render so the user lands directly in that
 *   session.
 * - Keeping argv parsing separate from the Ink entrypoint makes the behavior
 *   testable without booting the full terminal UI.
 * - The parser stays intentionally tiny: unknown argv falls back to normal
 *   startup so we do not accidentally turn future positional text into a
 *   pseudo-command.
 */
export function parseStartupCommand(argv: string[]): StartupCommand {
  const [firstArg, secondArg] = argv.map((value) => value.trim()).filter(Boolean);
  if (firstArg === "resume") {
    return {
      kind: "resume",
      sessionId: secondArg,
    };
  }
  return { kind: "default" };
}
