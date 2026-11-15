import { realpathSync } from "node:fs";
import { canonicalJson } from "./matcher.ts";
interface Annotations { readOnlyHint?: boolean; destructiveHint?: boolean }
export interface RegisteredToolIdentity {
  name: string;
  parameters?: unknown;
  sourceInfo?: { path: string };
  annotations?: Annotations;
}
interface McpRegistration {
  sourcePath: string;
  parameters: unknown;
  resolve(): { annotations?: Annotations } | undefined;
}
const KEY = Symbol.for("pi-monitor.mcp-tools.v1");
const shared = globalThis as typeof globalThis & { [KEY]?: Map<string, McpRegistration> };

/** Bind a real adapter registration to host-owned origin AND schema, not name. */
export function monitorToolEvidence(tool: RegisteredToolIdentity): { concreteMcp: boolean; annotations?: Annotations } {
  const entry = shared[KEY]?.get(tool.name);
  if (!entry) return { concreteMcp: false, annotations: tool.annotations };
  try {
    if (!tool.sourceInfo?.path || realpathSync(tool.sourceInfo.path) !== realpathSync(entry.sourcePath)
      || canonicalJson(tool.parameters) !== canonicalJson(entry.parameters)) return { concreteMcp: false };
    // Once an adapter owns the declaration, ignore stale host snapshots too.
    return { concreteMcp: true, annotations: entry.resolve()?.annotations };
  } catch { return { concreteMcp: false }; }
}
