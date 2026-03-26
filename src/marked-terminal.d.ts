declare module "marked-terminal" {
  export type MarkedTerminalOptions = {
    width?: number;
    reflowText?: boolean;
    showSectionPrefix?: boolean;
    emoji?: boolean;
    unescape?: boolean;
    tableOptions?: Record<string, unknown>;
    tab?: number | string;
  };

  export function markedTerminal(
    options?: MarkedTerminalOptions,
    highlightOptions?: Record<string, unknown>,
  ): Record<string, unknown>;
}