import { appendFile, mkdir, rename, stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyFailure } from "./error-classification.ts";
import { claimMonitorCall } from "./authorization.ts";

export interface MonitorDiagnostic {
  sessionId: string;
  monitorId: string;
  tool?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  category: "policy_denied" | "tool_unavailable" | "timeout" | "aborted" | "invalid_sample" | "tool_error" | "notification_unconfirmed" | "internal_error";
}
const LOG_PATH = join(homedir(), ".pi", "agent", "usage", "monitor-errors.jsonl");
const MAX_BYTES = 1024 * 1024;
let writes = Promise.resolve();
const identifier = (s: string | undefined) => s?.replace(/[^a-zA-Z0-9_:./-]/g, "_").slice(0, 160);

export function diagnosticRow(value: MonitorDiagnostic) {
  return { timestamp: new Date().toISOString(), sessionId: identifier(value.sessionId),
    monitorId: identifier(value.monitorId), tool: identifier(value.tool), toolCallId: identifier(value.toolCallId),
    parentToolCallId: identifier(value.parentToolCallId), category: value.category };
}

/** A bounded, separate diagnostic log. No tool args, output or error strings. */
export function recordDiagnostic(value: MonitorDiagnostic, path = LOG_PATH): Promise<void> {
  const line = JSON.stringify(diagnosticRow(value)) + "\n";
  writes = writes.then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const size = await stat(path).then(s => s.size).catch(() => 0);
    if (size + Buffer.byteLength(line) > MAX_BYTES) await rename(path, path + ".1");
    await appendFile(path, line, { mode: 0o600 });
  }).catch(() => { console.error("[pi-monitor] diagnostic write failed"); });
  return writes;
}

export function registerDiagnostics(pi: ExtensionAPI): void {
  const calls = new Map<string, { sessionId: string; monitorId: string; tool: string; parentToolCallId?: string }>();
  pi.on("tool_call", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const identity = claimMonitorCall("monitor-diagnostics", sessionId, event.toolName, event.input, event.toolCallId);
    if (!identity || calls.size >= 1000) return;
    calls.set(event.toolCallId, { sessionId, monitorId: identity.monitorId, tool: event.toolName, parentToolCallId: event.parentToolCallId });
  });
  pi.on("tool_result", (event) => {
    const identity = calls.get(event.toolCallId);
    if (!identity) return;
    calls.delete(event.toolCallId);
    // MCP's own hook may run later and turn its typed details into isError.
    const detailsError = event.details && typeof event.details === "object" && "error" in event.details;
    if (!event.isError && !detailsError) return;
    const text = event.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    void recordDiagnostic({ ...identity, toolCallId: event.toolCallId, category: classifyFailure(text) });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    for (const [id, value] of calls) if (value.sessionId === ctx.sessionManager.getSessionId()) calls.delete(id);
  });
  pi.registerCommand("monitor-errors", {
    description: "Show recent bounded monitor diagnostics (no arguments or tool output)",
    handler: async (_args, ctx) => {
      await writes;
      const text = await readFile(LOG_PATH, "utf8").catch(() => "");
      const rows = text.trim().split("\n").filter(Boolean).slice(-20);
      ctx.ui.notify(rows.length ? rows.join("\n") : "No monitor diagnostics recorded", "info");
    },
  });
}
