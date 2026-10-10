/**
 * Pi-Monitor type definitions
 */

export type MonitorStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled";

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

export interface MonitorOptions {
  intervalSeconds?: number;
  timeoutSeconds?: number;
  maxRetries?: number;
  description?: string;
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

export const MAX_CONCURRENT_MONITORS = 5;
export const MAX_STORED_RECORDS_PER_SESSION = 10;
export const MAX_CONTENT_LENGTH = 4096;
export const MIN_INTERVAL_SECONDS = 2;
export const MAX_INTERVAL_SECONDS = 300;
export const DEFAULT_INTERVAL_SECONDS = 5;
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 600;
export const DEFAULT_MAX_RETRIES = 3;
export const WIDGET_KEY = "pi-monitor";
export const NOTIFICATION_CUSTOM_TYPE = "pi-monitor:notification";
export const STATE_ENTRY_TYPE = "pi-monitor-state";
