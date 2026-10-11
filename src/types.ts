/**
 * Pi-Monitor type definitions
 */

export type MonitorStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled" | "interrupted";

/** Cancellation cause: explicit user/agent stop vs. session-lifecycle interruption. */
export type CancelKind = "explicit" | "interrupted";

export interface FieldCondition {
  field: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
  greaterThan?: number;
  lessThan?: number;
  greaterThanOrEqual?: number;
  lessThanOrEqual?: number;
  contains?: string;
}

export type MonitorCondition =
  | FieldCondition
  | { textContains: string }
  | { textMatches: string }
  | { resultSha256: string };

/** Stability policy: require N consecutive matching samples and/or a matched age. */
export interface StabilityOptions {
  consecutiveMatches?: number;
  stableForSeconds?: number;
}

export interface MonitorOptions extends StabilityOptions {
  intervalSeconds?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
  description?: string;
}

/** Bounded, redacted observation of the condition's relevant field for the UI. */
export interface ObservedValue {
  field: string;
  value: string;
  matched: boolean;
}

export interface MonitorRecord {
  id: string;
  sessionId: string;
  generation: number;
  tool: string;
  args: Record<string, unknown>;
  condition: MonitorCondition;
  options: {
    intervalSeconds: number;
    timeoutSeconds: number;
    maxRetries: number;
    consecutiveMatches: number;
    stableForSeconds: number;
    description?: string;
  };
  status: MonitorStatus;
  createdAt: number;
  startedAt: number;
  deadline: number;
  lastCheckedAt?: number;
  completedAt?: number;
  attempts: number;
  consecutiveErrors: number;
  // Health fields
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastErrorAt?: number;
  nextCheckAt?: number;
  lastErrorText?: string;
  consecutiveMatches: number;
  firstMatchAt?: number;
  lastObservedValue?: ObservedValue;
  interruptedBy?: string;
  lastResult?: {
    isError: boolean;
    content: string;
    structuredContent?: unknown;
    errorText?: string;
  };
  terminalReason?: string;
  notified: boolean;
}

export interface MatchEvaluationResult {
  matched: boolean;
  reason?: string;
}

/**
 * Durable, non-context session entry describing a monitor lifecycle event.
 * Reconstructed only from the active branch (`sessionManager.getBranch()`).
 * Never stores raw tool arguments or results; `argsHash` is a canonical digest.
 */
export interface MonitorPersistEntry {
  version: 1;
  monitorId: string;
  event: "started" | MonitorStatus;
  tool: string;
  argsHash: string;
  condition: MonitorCondition;
  options: MonitorRecord["options"];
  status: MonitorStatus;
  createdAt: number;
  terminalAt?: number;
  reason?: string;
  attempts?: number;
  interruptedBy?: string;
}

export const MAX_CONCURRENT_MONITORS = 5;
export const MAX_STORED_RECORDS_PER_SESSION = 10;
export const MAX_CONTENT_LENGTH = 4096;
export const MIN_INTERVAL_SECONDS = 2;
export const MAX_INTERVAL_SECONDS = 300;
export const DEFAULT_INTERVAL_SECONDS = 5;
export const DEFAULT_TIMEOUT_SECONDS = 120;
// Hourly-bounded waiting: up to seven days. Kept as the hard timeout ceiling.
export const MAX_TIMEOUT_SECONDS = 604800;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_CONSECUTIVE_MATCHES = 1;
export const MAX_CONSECUTIVE_MATCHES = 1000;
export const DEFAULT_STABLE_FOR_SECONDS = 0;
export const MAX_STABLE_FOR_SECONDS = 604800;
export const WIDGET_KEY = "pi-monitor";
export const NOTIFICATION_CUSTOM_TYPE = "pi-monitor:notification";
export const STATE_ENTRY_TYPE = "pi-monitor-state";
