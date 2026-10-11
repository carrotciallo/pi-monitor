/** Shell commands are unrestricted; query-only behavior is a prompt constraint. */
export function isAllowedShellQuery(args: Record<string, unknown>): boolean {
  return typeof args.command === "string" && args.command.trim().length > 0;
}
