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
  if (status === "interrupted") {
    return `${ANSI.yellow}${ANSI.bold}[INTERRUPTED]${ANSI.reset}`;
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
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

export function formatTimeHHMMSS(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toTimeString().split(" ")[0] ?? "";
}

/**
 * Renders the compact health suffix: match progress, stability progress, last
 * success age, retries and next check. Only bounded, pre-redacted fields from
 * the record are used.
 */
export function formatHealthSuffix(record: MonitorRecord, now = Date.now()): string {
  const parts: string[] = [];
  const required = record.options.consecutiveMatches;
  if (required > 1 || record.consecutiveMatches > 0) {
    parts.push(`match ${record.consecutiveMatches}/${required}`);
  }
  // Stability progress: how long the match must still hold vs. required.
  if (record.options.stableForSeconds > 0) {
    const elapsed = record.firstMatchAt !== undefined ? Math.floor((now - record.firstMatchAt) / 1000) : 0;
    parts.push(`stable ${elapsed}s/${record.options.stableForSeconds}s`);
  }
  // Last success age reassures the query itself is healthy.
  if (typeof record.lastSuccessAt === "number") {
    const age = Math.max(0, Math.floor((now - record.lastSuccessAt) / 1000));
    parts.push(`ok ${age}s ago`);
  }
  if (record.consecutiveErrors > 0) {
    parts.push(`errors ${record.consecutiveErrors}`);
  }
  const nextAt = record.nextCheckAt;
  if (record.status === "running" && typeof nextAt === "number") {
    const remaining = Math.max(0, Math.ceil((nextAt - now) / 1000));
    parts.push(`next ${remaining}s`);
  }
  return parts.join(" · ");
}

/**
 * Renders the concise relevant field observation `field=value`, or undefined.
 * The value is bounded and already redacted by the scheduler.
 */
export function formatObservedValue(record: MonitorRecord): string | undefined {
  const observed = record.lastObservedValue;
  if (!observed) return undefined;
  return `${observed.field}=${observed.value}`;
}

/**
 * Renders the declared display projections as `label=value` segments, so a
 * polled script can report progress in the widget. Values are bounded and
 * redacted at capture time; this only joins them.
 */
export function formatDisplayValues(record: MonitorRecord): string | undefined {
  const values = record.displayValues;
  if (!values || values.length === 0) return undefined;
  return values.map(v => `${v.label}=${v.value}`).join(" · ");
}

/**
 * Builds the lines displayed in Pi-Web above-editor widget.
 */
export function formatWidgetLines(records: MonitorRecord[], now = Date.now()): string[] {
  if (records.length === 0) return [];
  const active = records.filter(r => r.status === "running");
  const visible = (active.length > 0 ? active : records)
    .slice().sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, active.length > 0 ? 5 : 1);
  const labels: Record<MonitorStatus, string> = {
    running: "Running", completed: "Completed", failed: "Failed",
    timed_out: "Timed out", interrupted: "Interrupted", cancelled: "Cancelled",
  };
  return visible.map(r => {
    const name = Array.from((r.options.description || "Background monitor").replace(/\s+/g, " ").trim());
    const label = name.length > 20 ? name.slice(0, 19).join("") + "…" : name.join("");
    const status = r.status === "running" && r.consecutiveErrors > 0 ? "Retrying" : labels[r.status];
    const color = r.status === "running" ? ANSI.cyan : r.status === "completed" ? ANSI.green : ANSI.gray;
    const elapsed = formatElapsedTime(r.startedAt, r.completedAt ?? now);
    const health = formatHealthSuffix(r, now);
    const observed = formatObservedValue(r);
    const display = formatDisplayValues(r);
    const details = [health, observed, display].filter(Boolean).join(" · ");
    const suffix = details ? ` · ${details}` : "";
    return `${color}${status}${ANSI.reset} ${label} · ${r.attempts} checks · ${elapsed}${suffix}`;
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
    interrupted: "Monitoring ended because the session lifecycle changed; the underlying operation was not necessarily cancelled.",
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

/**
 * Builds a concise resume notice for monitors interrupted by a session lifecycle
 * change. Used for UI notification and non-UI context delivery; it is not
 * delivered as a turn-waking message.
 */
export function formatInterruptionNotice(
  records: ReadonlyArray<{ id: string; options?: { description?: string } }>
): string | undefined {
  if (records.length === 0) return undefined;
  const labels = records.map(r => {
    const description = r.options?.description;
    const name = description ? ` (${Array.from(description.replace(/\s+/g, " ").trim()).slice(0, 40).join("")})` : "";
    return `${r.id}${name}`;
  });
  return `[Pi-Monitor] ${records.length} background monitor(s) interrupted by a session/branch change and stopped: ${labels.join(", ")}. Use monitor_status for details and restart if still needed.`;
}
