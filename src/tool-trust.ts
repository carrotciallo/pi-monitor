/**
 * User-editable tool trust for background monitors.
 *
 * pi-monitor defaults to deny: `monitor_start` may only poll a tool that is
 * provably read-only. MCP servers differ widely in how, and whether, they
 * describe their tools, so an operator needs a way to vouch for a specific tool
 * without patching pi-monitor or weakening the default for everything else.
 *
 * Trust is declared in a Markdown file, so prose and rules live together the way
 * AGENTS.md carries instructions:
 *
 *   ~/.pi/agent/pi-monitor.md   user-level; always read
 *   <cwd>/PI-MONITOR.md         project-level; read only when the project is trusted
 *
 * Only list items under an Allow or Deny heading are rules; every other line is
 * documentation. Patterns are globs (`*` matches any run of characters, `?`
 * matches exactly one) matched case-insensitively against the tool name.
 *
 * Trust is deliberately narrow:
 *  - Deny always wins over Allow.
 *  - Allow can never override the hard blocks in `isAllowedMonitorTool`:
 *    forbidden gateways, `destructiveHint: true`, and mutating tool names.
 *  - A namespace proxy such as `mcp__bambu_printer` cannot be trusted at all,
 *    because trusting it would hand the monitor every tool behind the proxy.
 *  - The project-level file is ignored unless the host reports the project as
 *    trusted, so an untrusted repository cannot grant itself monitoring access.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Headings that switch the parser into its allow section. */
const ALLOW_HEADINGS = new Set(["allow", "allowed", "trust", "trusted", "permit", "permitted"]);

/** Headings that switch the parser into its deny section. */
const DENY_HEADINGS = new Set(["deny", "denied", "block", "blocked", "forbid", "forbidden"]);

/** Trust files larger than this are ignored rather than parsed. */
export const MAX_TRUST_FILE_BYTES = 128 * 1024;

/** Project-level trust file, at the repository root next to README.md. */
export const PROJECT_TRUST_FILE_NAME = "PI-MONITOR.md";

export interface ToolTrust {
  /** Patterns that grant monitoring access, compiled. */
  readonly allow: readonly RegExp[];
  /** Patterns that remove monitoring access, compiled. Checked before `allow`. */
  readonly deny: readonly RegExp[];
  /** The literal allow patterns, in file order, for reporting. */
  readonly allowPatterns: readonly string[];
  /** The literal deny patterns, in file order, for reporting. */
  readonly denyPatterns: readonly string[];
  /** Files that contributed at least one rule. */
  readonly sources: readonly string[];
}

export interface ToolTrustOptions {
  /** Session working directory; the project file is looked up here. */
  cwd?: string;
  /** Whether project-local trust is active. The project file is read only when true. */
  projectTrusted?: boolean;
  /** Override for the user-level path. Tests use this to avoid the real home directory. */
  userPath?: string;
}

/**
 * The user-level trust file, normally `~/.pi/agent/pi-monitor.md`. The
 * `PI_MONITOR_TRUST_FILE` environment variable overrides the location, which
 * lets a machine keep the rules outside the agent directory.
 */
export function userTrustFilePath(): string {
  const override = process.env.PI_MONITOR_TRUST_FILE?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent", "pi-monitor.md");
}

/** The project-level trust file inside `cwd`. */
export function projectTrustFilePath(cwd: string): string {
  return join(cwd, PROJECT_TRUST_FILE_NAME);
}

/**
 * Turns a glob into an anchored, case-insensitive regular expression. Only `*`
 * and `?` are special; every other character is matched literally, so a tool
 * name containing `.`, `+`, or parentheses cannot change the pattern's meaning.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

/** True when the tool name matches any of the compiled patterns. */
export function matchesToolPatterns(toolName: string, patterns: readonly RegExp[]): boolean {
  for (const pattern of patterns) {
    if (pattern.test(toolName)) return true;
  }
  return false;
}

/**
 * Extracts one rule from a list item's text: unwraps Markdown code spans and
 * drops trailing documentation, so `- \`mail_list_*\` — read-only listings`
 * yields `mail_list_*`.
 */
function normalizePattern(text: string): string | undefined {
  let value = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/`/g, " ").trim();
  if (!value) return undefined;
  // Documentation may follow the pattern after an em dash, a spaced hyphen, or
  // two or more spaces. A bare `-` is kept: tool names such as
  // `bambu-printer_get_printer_status` contain one.
  const cut = value.search(/\s[—–]\s|\s+-\s+|\s{2,}/);
  if (cut > 0) value = value.slice(0, cut).trim();
  return value || undefined;
}

/**
 * Parses rules from Markdown. Headings select the section; list items are rules;
 * everything else is documentation and is ignored.
 */
export function parseToolTrust(markdown: string): { allow: string[]; deny: string[] } {
  const allow: string[] = [];
  const deny: string[] = [];
  let section: "allow" | "deny" | undefined;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      const name = (heading[1] ?? "").toLowerCase().replace(/[^a-z]/g, "");
      section = ALLOW_HEADINGS.has(name) ? "allow" : DENY_HEADINGS.has(name) ? "deny" : undefined;
      continue;
    }

    const item = /^[-*+]\s+(.*)$/.exec(line);
    if (!item || section === undefined) continue;

    const pattern = normalizePattern(item[1] ?? "");
    if (!pattern) continue;
    (section === "allow" ? allow : deny).push(pattern);
  }

  return { allow, deny };
}

interface CachedTrustFile {
  mtimeMs: number;
  size: number;
  markdown: string | undefined;
}

const fileCache = new Map<string, CachedTrustFile>();

/** Reads a trust file, or undefined when it is absent, unreadable, or too large. */
function readTrustFile(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_TRUST_FILE_BYTES) return undefined;
    const cached = fileCache.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.markdown;
    const markdown = readFileSync(path, "utf8");
    fileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, markdown });
    return markdown;
  } catch {
    fileCache.delete(path);
    return undefined;
  }
}

/**
 * Loads the effective trust rules. A missing or unreadable file simply
 * contributes no rules, which leaves the default deny in place.
 */
export function loadToolTrust(options: ToolTrustOptions = {}): ToolTrust {
  const allow: string[] = [];
  const deny: string[] = [];
  const sources: string[] = [];

  const userPath = options.userPath ?? userTrustFilePath();
  const userMarkdown = readTrustFile(userPath);
  if (userMarkdown !== undefined) {
    const parsed = parseToolTrust(userMarkdown);
    allow.push(...parsed.allow);
    deny.push(...parsed.deny);
    sources.push(userPath);
  }

  if (options.cwd && options.projectTrusted === true) {
    const projectPath = projectTrustFilePath(options.cwd);
    if (projectPath !== userPath) {
      const projectMarkdown = readTrustFile(projectPath);
      if (projectMarkdown !== undefined) {
        const parsed = parseToolTrust(projectMarkdown);
        allow.push(...parsed.allow);
        deny.push(...parsed.deny);
        sources.push(projectPath);
      }
    }
  }

  return {
    allow: allow.map(globToRegExp),
    deny: deny.map(globToRegExp),
    allowPatterns: allow,
    denyPatterns: deny,
    sources,
  };
}

/**
 * Reads the host's project-trust state defensively. A context without the
 * method, or one that throws, is treated as untrusted.
 */
export function resolveProjectTrust(ctx: unknown): boolean {
  const candidate = (ctx as { isProjectTrusted?: unknown } | undefined)?.isProjectTrusted;
  if (typeof candidate !== "function") return false;
  try {
    return Boolean((candidate as () => unknown).call(ctx));
  } catch {
    return false;
  }
}
