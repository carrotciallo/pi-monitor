/**
 * Recovers MCP tool annotations from pi-mcp-adapter's on-disk cache.
 *
 * The adapter registers MCP tools with Pi but does not forward the server's
 * `annotations` payload: its `DirectToolSpec` has no annotations field, and the
 * surface builder copies only name/description/inputSchema. A read-only MCP
 * tool therefore reaches pi-monitor looking unproven and lands on the default
 * deny, even though the server explicitly declared `readOnlyHint: true`.
 *
 * The adapter's own cache (`~/.pi/agent/mcp-cache.json`) does retain the
 * payload. This module maps Pi's flat tool name back to the cache entry so a
 * server's own declaration is honoured without patching the adapter.
 *
 * This is evidence only. It can never admit what a hard block denies, because
 * `isAllowedMonitorTool` checks `destructiveHint` and the mutating-name rules
 * before it consults annotations. A tool whose cache entry says
 * `destructiveHint: true` is rejected either way.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Cache files larger than this are ignored rather than parsed. */
export const MAX_MCP_CACHE_BYTES = 8 * 1024 * 1024;

export interface McpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolEntry {
  /** The MCP server that owns the tool, as configured. */
  serverName: string;
  /** The tool name as the server declares it, e.g. `list_emails_metadata`. */
  originalName: string;
  /** The full tool name Pi exposes, e.g. `mail_list_emails_metadata`. */
  exposedName: string;
  annotations: McpAnnotations;
}

export interface McpLookupOptions {
  /** Override the cache location. Tests use this to avoid the real home directory. */
  cachePath?: string;
}

/**
 * The adapter's cache path, normally `~/.pi/agent/mcp-cache.json`. The
 * `PI_MONITOR_MCP_CACHE` environment variable overrides the location.
 */
export function mcpCachePath(): string {
  const override = process.env.PI_MONITOR_MCP_CACHE?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent", "mcp-cache.json");
}

/**
 * Every server-name spelling the adapter might have used as a prefix. The
 * adapter sanitizes the configured server name before prefixing a tool name,
 * so `bambu-printer` can surface as `bambu_printer`.
 */
function serverNameForms(serverName: string): string[] {
  const forms = new Set<string>([serverName]);
  forms.add(serverName.replace(/[.-]/g, "_"));
  forms.add(serverName.replace(/[.-]/g, "_").replace(/_?mcp$/i, ""));
  forms.delete("");
  return [...forms];
}

/** Tool names have their dots flattened by the adapter. */
function toolNameForms(toolName: string): string[] {
  return toolName.includes(".") ? [toolName, toolName.replace(/\./g, "_")] : [toolName];
}

interface CacheFileState {
  mtimeMs: number;
  size: number;
  index: Map<string, McpToolEntry>;
}

const cacheStates = new Map<string, CacheFileState>();

/**
 * Builds an exact-match index from every plausible exposed name to its cache
 * entry. Names produced by more than one server are dropped, matching the
 * adapter's rule that an unqualified name has an owner only when exactly one
 * eligible entry produces it.
 */
function buildIndex(cache: unknown): Map<string, McpToolEntry> {
  const index = new Map<string, McpToolEntry>();
  const ambiguous = new Set<string>();
  const servers = (cache as { servers?: unknown })?.servers;
  if (!servers || typeof servers !== "object") return index;

  for (const [serverName, serverValue] of Object.entries(servers as Record<string, unknown>)) {
    const tools = (serverValue as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) continue;

    for (const tool of tools) {
      const originalName = (tool as { name?: unknown })?.name;
      if (typeof originalName !== "string" || !originalName) continue;

      const rawAnnotations = (tool as { annotations?: unknown })?.annotations;
      if (!rawAnnotations || typeof rawAnnotations !== "object") continue;

      const source = rawAnnotations as Record<string, unknown>;
      const annotations: McpAnnotations = {};
      for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
        if (typeof source[key] === "boolean") annotations[key] = source[key] as boolean;
      }
      if (Object.keys(annotations).length === 0) continue;

      for (const serverForm of serverNameForms(serverName)) {
        for (const toolForm of toolNameForms(originalName)) {
          const entry: McpToolEntry = { serverName, originalName, exposedName: toolForm, annotations };
          // Prefix modes: "server" and "short" join with `_`; "mcp" adds the
          // `mcp__` namespace and joins with `__`; "none" exposes the bare name.
          const candidates = [
            `${serverForm}_${toolForm}`,
            `${serverForm}__${toolForm}`,
            `mcp__${serverForm}_${toolForm}`,
            `mcp__${serverForm}__${toolForm}`,
            toolForm,
          ];
          for (const candidate of candidates) {
            const existing = index.get(candidate);
            if (existing === undefined) {
              index.set(candidate, { ...entry, exposedName: candidate });
            } else if (
              existing.serverName !== serverName ||
              existing.originalName !== originalName
            ) {
              ambiguous.add(candidate);
            }
          }
        }
      }
    }
  }

  for (const name of ambiguous) index.delete(name);
  return index;
}

/** Reads and indexes the cache, reusing the last parse while the file is unchanged. */
function loadIndex(path: string): Map<string, McpToolEntry> | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MCP_CACHE_BYTES) return undefined;

    const cached = cacheStates.get(path);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.index;

    const index = buildIndex(JSON.parse(readFileSync(path, "utf8")));
    cacheStates.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, index });
    return index;
  } catch {
    cacheStates.delete(path);
    return undefined;
  }
}

/**
 * Looks up the annotations a server declared for `toolName`. Returns undefined
 * when the cache is absent, unreadable, or has no entry for the name; callers
 * then fall back to the default deny.
 */
export function lookupCachedMcpTool(
  toolName: string,
  options: McpLookupOptions = {}
): McpToolEntry | undefined {
  if (!toolName || typeof toolName !== "string") return undefined;
  const index = loadIndex(options.cachePath ?? mcpCachePath());
  return index?.get(toolName);
}

/**
 * Merges the annotations Pi reports with the ones the server declared. Live
 * values win, because an explicit `false` from Pi means the server really said
 * so; the cache only fills in what Pi dropped.
 */
export function resolveToolAnnotations(
  toolName: string,
  live?: McpAnnotations,
  options: McpLookupOptions = {}
): McpAnnotations | undefined {
  const cached = lookupCachedMcpTool(toolName, options)?.annotations;
  if (!cached) return live;
  if (!live) return cached;
  return {
    readOnlyHint: live.readOnlyHint ?? cached.readOnlyHint,
    destructiveHint: live.destructiveHint ?? cached.destructiveHint,
  };
}
