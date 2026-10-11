import type { MonitorPersistEntry, MonitorStatus } from "./types.ts";

/**
 * Lifecycle semantics for pi-monitor.
 *
 * Session lifecycle events (branch switch, session switch, reload, quit) stop
 * monitors as `interrupted`, which is distinct from an explicit user/agent
 * cancellation. Interruptions never send a turn-waking followUp, so they cannot
 * wake the wrong branch or session. The distinction is persisted as non-context
 * session entries; on reload the active branch alone is used to reconstruct it.
 *
 * Limits: session entries are durable on disk, but the extension's in-memory
 * runtime state is not. After a reload, only descriptors on the active branch
 * are visible; descriptors written on a branch that is no longer active are not
 * consulted. Reconstructing is read-only and never resumes execution.
 */

const SHUTDOWN_LABELS: Record<string, string> = {
  quit: "interrupted: Pi quit",
  reload: "interrupted: extension reload",
  new: "interrupted: new session",
  resume: "interrupted: session switched",
  fork: "interrupted: session forked",
};

/** Maps a session_shutdown reason to a concise interruption label. */
export function classifyShutdownReason(reason: string): string {
  return SHUTDOWN_LABELS[reason] ?? `interrupted: session shutdown (${reason})`;
}

function descriptorLabel(entry: MonitorPersistEntry): string {
  const label = entry.options.description || entry.tool;
  return Array.from(label.replace(/\s+/g, " ").trim()).slice(0, 40).join("");
}

/**
 * Builds a concise notice for running descriptors that no live monitor backs,
 * for example after a reload. Returns undefined when nothing was lost.
 */
export function formatLostMonitorNotice(lost: readonly MonitorPersistEntry[]): string | undefined {
  if (lost.length === 0) return undefined;
  const parts = lost.slice(0, 5).map(e => `${e.monitorId} (${descriptorLabel(e)})`);
  const extra = lost.length > 5 ? `, +${lost.length - 5} more` : "";
  return `[Pi-Monitor] ${lost.length} background monitor(s) were running when this session last persisted and are no longer active (lost on reload/restart): ${parts.join(", ")}${extra}. In-memory monitor state is not durable; restart the monitor if it is still needed.`;
}

/** Terminal statuses that must never trigger a turn-waking notification. */
export function isSilentTerminal(status: MonitorStatus): boolean {
  return status === "cancelled" || status === "interrupted";
}
