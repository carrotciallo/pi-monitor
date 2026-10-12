/**
 * Strict shell JSON adaptation.
 *
 * Field conditions need a structured object. Shell tools return text, and some
 * hosts wrap the real command output in a known envelope. This module resolves a
 * structured value from a tool result using only deterministic, documented rules:
 *
 * 1. A shell result envelope `{ output: string, exit_code: number, ... }` is
 *    unwrapped only for the known shell tools and only when the command
 *    succeeded (`exit_code === 0`). Failed commands are never adapted.
 * 2. Any explicit truncation, timeout, kill or error wrapper is rejected rather
 *    than stripped: a truncated body may be a valid JSON prefix whose remainder
 *    was omitted, so accepting it would silently match on partial data.
 * 3. Otherwise the text content is parsed as strict JSON, accepting only a body
 *    that is entirely JSON (after `trim()`), with no surrounding or trailing
 *    text at all.
 * 4. The MCP adapter appends the server's payload to the text it returns
 *    instead of forwarding it as `structuredContent`. It writes a marker line
 *    followed by pretty-printed JSON, so the payload is still recovered
 *    exactly, never by fuzzy extraction.
 *
 * There is no fragment scanning, brace balancing, or other fuzzy extraction.
 * Non-shell `structuredContent` objects are still used as-is, because that is
 * already host-provided structured data, not text to adapt.
 */

export type StructuredSourceKind = "structured-content" | "shell-output" | "json-content" | "mcp-structured";

export interface StructuredSource {
  value: unknown;
  kind: StructuredSourceKind;
}

export interface ToolResultLike {
  isError: boolean;
  content: string;
  structuredContent?: unknown;
  /** Optional host tool name; restricts shell-envelope adaptation to shell tools. */
  toolName?: string;
}

/** Tool names whose `structuredContent` is a known shell result envelope. */
const SHELL_TOOLS = new Set(["bash", "hypa_shell"]);

/** Substrings that mark truncation, timeout, kill or failure wrappers. */
const TRUNCATING_NOTICES: readonly RegExp[] = [
  /\[Output truncated:/,
  /\[Hypa command timed out or was killed\]/,
  /\[Showing last /,
  /\[Showing lines /,
  /\bCommand exited with code /,
  /\bCommand timed out after /,
  /\bCommand aborted\b/,
  /\bCommand terminated without an exit code\b/,
];

/** The bash result envelope shape. */
export function isShellEnvelope(value: unknown): value is { output: string; exit_code: number } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.output === "string" && typeof record.exit_code === "number";
}

/** True when the text carries an explicit truncation/timeout/kill/error wrapper. */
export function hasTruncationOrErrorWrapper(text: string): boolean {
  return TRUNCATING_NOTICES.some(pattern => pattern.test(text));
}

/**
 * Parses strict JSON, returning undefined on any parse failure. Accepts only a
 * body that is entirely JSON; never a substring of the input.
 */
export function strictParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * The marker the MCP adapter writes before the structured payload it could not
 * forward as `structuredContent`. It always occupies its own line, and the
 * adapter joins it to the preceding text block with a newline.
 */
const MCP_STRUCTURED_MARKER = "structuredContent:\n";

/**
 * Recovers a structured payload the MCP adapter demoted to text. The adapter
 * appends the marker last, so the rightmost marker is tried first; the search
 * then walks leftward so a literal marker inside the payload itself cannot mask
 * the real one. Only a marker that starts a line counts, and its remainder must
 * parse as strict JSON, so nothing is ever extracted from partial data.
 */
export function resolveMcpStructuredContent(content: string): StructuredSource | undefined {
  let before = content.length;
  for (;;) {
    const at = content.lastIndexOf(MCP_STRUCTURED_MARKER, before);
    if (at < 0) return undefined;
    if (at === 0 || content[at - 1] === "\n") {
      const parsed = strictParseJson(content.slice(at + MCP_STRUCTURED_MARKER.length));
      if (parsed !== undefined) return { value: parsed, kind: "mcp-structured" };
    }
    // A marker at offset 0 has nothing to its left; stop rather than re-find it.
    if (at === 0) return undefined;
    before = at - 1;
  }
}

/**
 * Resolves the structured value for a result, or undefined when the result is
 * not structured under the strict rules above. Shell-envelope handling requires
 * an explicit known shell `toolName`; a missing or unknown name is never
 * unwrapped, so an arbitrary `{ output, exit_code }` object is not mistaken for
 * shell output.
 */
export function resolveStructuredSource(result: ToolResultLike): StructuredSource | undefined {
  const isShellTool = result.toolName !== undefined && SHELL_TOOLS.has(result.toolName);
  const structured = result.structuredContent;

  // Envelope adaptation: only for known shell tools and only on success.
  if (isShellTool && isShellEnvelope(structured)) {
    if (structured.exit_code !== 0) return undefined;
    const inner = strictParseJson(structured.output);
    if (inner !== undefined) {
      return { value: inner, kind: "shell-output" };
    }
    return { value: structured, kind: "structured-content" };
  }

  if (structured !== null && typeof structured === "object") {
    return { value: structured, kind: "structured-content" };
  }

  const content = result.content ?? "";
  // Reject any wrapper that signals truncation, timeout, kill or failure.
  if (hasTruncationOrErrorWrapper(content)) return undefined;

  const parsed = strictParseJson(content);
  if (parsed !== undefined) {
    return { value: parsed, kind: "json-content" };
  }

  return resolveMcpStructuredContent(content);
}
