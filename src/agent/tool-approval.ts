const TOOLS_REQUIRING_APPROVAL = new Set<string>(["bash", "write_file", "edit_file"]);

export function toolNeedsApproval(name: string): boolean {
  return TOOLS_REQUIRING_APPROVAL.has(name);
}

export function buildToolRejectionOutput(name: string): string {
  return `Rejected by user: the tool "${name}" was not run. Do not retry it. Ask the user how they would like to proceed.`;
}
