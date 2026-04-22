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
  const trimmed = inputValue.trim().toLowerCase();
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
  const cmd = parts[0];

  switch (cmd) {
    case "help":
    case "status":
    case "mcp":
    case "team":
    case "inbox":
    case "compact":
    case "new":
    case "exit":
      return withoutSlash;
    case "provider":
    case "model":
    case "login":
    case "logout":
      return withoutSlash;
    case "quit":
      return "exit";
    default:
      return null;
  }
}
