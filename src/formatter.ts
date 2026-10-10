import type { MonitorRecord, MonitorStatus } from "./types.ts";

// ANSI escape sequences
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
};

export function formatStatusBadge(status: MonitorStatus, consecutiveErrors = 0): string {
  if (status === "running") {
    if (consecutiveErrors > 0) {
      return `${ANSI.yellow}${ANSI.bold}[RETRYING (${consecutiveErrors})]${ANSI.reset}`;
    }
    return `${ANSI.cyan}${ANSI.bold}[RUNNING]${ANSI.reset}`;
  }
  if (status === "completed") {
    return `${ANSI.green}${ANSI.bold}[COMPLETED]${ANSI.reset}`;
  }
  if (status === "failed") {
    return `${ANSI.red}${ANSI.bold}[FAILED]${ANSI.reset}`;
  }
  if (status === "timed_out") {
    return `${ANSI.red}${ANSI.bold}[TIMED_OUT]${ANSI.reset}`;
  }
  if (status === "cancelled") {
    return `${ANSI.gray}${ANSI.bold}[CANCELLED]${ANSI.reset}`;
  }
  return `[${status}]`;
}

export function formatCondition(record: MonitorRecord): string {
  const c = record.condition;
  if ("field" in c) {
    if (c.equals !== undefined) return `${c.field} == ${JSON.stringify(c.equals)}`;
    if (c.notEquals !== undefined) return `${c.field} != ${JSON.stringify(c.notEquals)}`;
    if (c.in !== undefined) return `${c.field} in [${c.in.map(x => JSON.stringify(x)).join(",")}]`;
    if (c.greaterThan !== undefined) return `${c.field} > ${c.greaterThan}`;
    if (c.greaterThanOrEqual !== undefined) return `${c.field} >= ${c.greaterThanOrEqual}`;
    if (c.lessThan !== undefined) return `${c.field} < ${c.lessThan}`;
    if (c.lessThanOrEqual !== undefined) return `${c.field} <= ${c.lessThanOrEqual}`;
    if (c.contains !== undefined) return `${c.field} contains "${c.contains}"`;
    return `${c.field}`;
  }
  if ("textContains" in c) return `text contains "${c.textContains}"`;
  if ("textMatches" in c) return `text matches /${c.textMatches}/`;
  if ("resultSha256" in c) return `sha256 == ${c.resultSha256.slice(0, 8)}...`;
  return "custom condition";
}

export function formatElapsedTime(startMs: number, endMs = Date.now()): string {
  const totalSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

export function formatTimeHHMMSS(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toTimeString().split(" ")[0] ?? "";
}

/**
 * Builds the lines displayed in Pi-Web above-editor widget.
 */
export function formatWidgetLines(records: MonitorRecord[]): string[] {
  if (records.length === 0) return [];
  const active = records.filter(r => r.status === "running");
  const visible = (active.length > 0 ? active : records)
    .slice().sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, active.length > 0 ? 5 : 1);
  const labels: Record<MonitorStatus, string> = {
    running: "Running", completed: "Completed", failed: "Failed",
    timed_out: "Timed out", cancelled: "Cancelled",
  };
  return visible.map(r => {
    const name = Array.from((r.options.description || "Background monitor").replace(/\s+/g, " ").trim());
    const label = name.length > 20 ? name.slice(0, 19).join("") + "…" : name.join("");
    const status = r.status === "running" && r.consecutiveErrors > 0 ? "Retrying" : labels[r.status];
    const color = r.status === "running" ? ANSI.cyan : r.status === "completed" ? ANSI.green : ANSI.gray;
    const elapsed = formatElapsedTime(r.startedAt, r.completedAt ?? Date.now());
    return `${color}${status}${ANSI.reset} ${label} · ${r.attempts} checks · ${elapsed}`;
  });
}

/**
 * Builds the notification message sent to original session to wake the model.
 */
export function formatCompletionNotification(record: MonitorRecord): string {
  const duration = formatElapsedTime(record.startedAt, record.completedAt ?? Date.now());
  const label = Array.from((record.options.description || "Background monitor")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 64).join("");
  const meaning: Record<MonitorStatus, string> = {
    running: "Monitoring is still in progress.",
    completed: "The configured condition matched; this establishes only that condition.",
    failed: "The monitoring query failed; this does not establish failure of the underlying operation.",
    timed_out: "The condition was not observed before the deadline; this does not establish failure of the underlying operation.",
    cancelled: "Monitoring was cancelled; the underlying operation was not necessarily cancelled.",
  };
  return [
    `[Pi-Monitor] Background monitor ended: ${record.id}`,
    `Task: ${label}`,
    `Status: ${record.status}`,
    `Meaning: ${meaning[record.status]}`,
    `Elapsed: ${duration}; checks: ${record.attempts}.`,
    "This is a status report, not authorization for automatic retries or further actions. Use monitor_status for details if needed.",
  ].join("\n");
}
