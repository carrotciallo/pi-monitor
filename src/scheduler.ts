import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatCompletionNotification, formatWidgetLines } from "./formatter.ts";
import { matchesCondition } from "./matcher.ts";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_CONCURRENT_MONITORS,
  MAX_CONTENT_LENGTH,
  MAX_INTERVAL_SECONDS,
  MAX_STORED_RECORDS_PER_SESSION,
  MAX_TIMEOUT_SECONDS,
  MIN_INTERVAL_SECONDS,
  type MonitorCondition,
  type MonitorOptions,
  type MonitorRecord,
  NOTIFICATION_CUSTOM_TYPE,
  WIDGET_KEY,
} from "./types.ts";

export interface ToolExecutionOptions {
  signal: AbortSignal;
  parentToolCallId?: string;
}

export interface ToolExecutor {
  (
    toolName: string,
    args: Record<string, unknown>,
    options: ToolExecutionOptions | AbortSignal,
    ctx?: ExtensionContext
  ): Promise<{
    content: string;
    structuredContent?: unknown;
    isError: boolean;
    errorText?: string;
  }>;
}

export class MonitorScheduler {
  private records = new Map<string, MonitorRecord>();
  private sessionMonitors = new Map<string, Set<string>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private deadlineTimers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Map<string, boolean>();
  private abortControllers = new Map<string, AbortController>();
  private toolExecutor: ToolExecutor;
  private pi?: ExtensionAPI;
  private uiContexts = new Map<string, ExtensionContext>();
  private toolContexts = new Map<string, ExtensionContext>();
  private clearWidgetTimers = new Map<string, NodeJS.Timeout>();

  constructor(toolExecutor: ToolExecutor, pi?: ExtensionAPI) {
    this.toolExecutor = toolExecutor;
    this.pi = pi;
  }

  public setExtensionAPI(pi: ExtensionAPI): void {
    this.pi = pi;
  }

  public registerContext(sessionId: string, ctx: ExtensionContext): void {
    this.registerUIContext(sessionId, ctx);
    this.registerToolContext(sessionId, ctx);
  }

  public registerUIContext(sessionId: string, ctx: ExtensionContext): void {
    this.uiContexts.set(sessionId, ctx);
  }

  public registerToolContext(sessionId: string, ctx: ExtensionContext): void {
    if (typeof (ctx as ExtensionContext & { executeTool?: unknown }).executeTool === "function") {
      this.toolContexts.set(sessionId, ctx);
    }
  }

  public getRecord(id: string): MonitorRecord | undefined {
    return this.records.get(id);
  }

  public getSessionRecords(sessionId: string): MonitorRecord[] {
    const ids = this.sessionMonitors.get(sessionId);
    if (!ids) return [];
    return Array.from(ids)
      .map(id => this.records.get(id))
      .filter((r): r is MonitorRecord => r !== undefined);
  }

  private pruneSessionRecords(sessionId: string): void {
    const ids = this.sessionMonitors.get(sessionId);
    if (!ids || ids.size <= MAX_STORED_RECORDS_PER_SESSION) return;

    const sessionRecords = Array.from(ids)
      .map(id => this.records.get(id))
      .filter((r): r is MonitorRecord => r !== undefined);

    const nonRunning = sessionRecords
      .filter(r => r.status !== "running")
      .sort((a, b) => a.createdAt - b.createdAt);

    while (ids.size > MAX_STORED_RECORDS_PER_SESSION && nonRunning.length > 0) {
      const oldest = nonRunning.shift()!;
      ids.delete(oldest.id);
      this.records.delete(oldest.id);
    }
  }

  public startMonitor(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    condition: MonitorCondition,
    options: MonitorOptions = {},
    ctx?: ExtensionContext
  ): MonitorRecord {
    if (ctx) {
      this.registerContext(sessionId, ctx);
    }

    // Check concurrency limit for running monitors in this session
    const existing = this.getSessionRecords(sessionId);
    const runningCount = existing.filter(r => r.status === "running").length;
    if (runningCount >= MAX_CONCURRENT_MONITORS) {
      throw new Error(`Exceeded maximum concurrent monitors limit (${MAX_CONCURRENT_MONITORS}) for session ${sessionId}`);
    }

    // Bounds normalization
    const intervalSec = Math.max(
      MIN_INTERVAL_SECONDS,
      Math.min(MAX_INTERVAL_SECONDS, options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS)
    );
    const timeoutSec = Math.max(
      MIN_INTERVAL_SECONDS * 2,
      Math.min(MAX_TIMEOUT_SECONDS, options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)
    );
    const maxRetries = Math.max(0, Math.min(10, options.maxRetries ?? DEFAULT_MAX_RETRIES));

    const id = `mon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();
    const deadline = now + timeoutSec * 1000;

    const record: MonitorRecord = {
      id,
      sessionId,
      generation: 1,
      tool,
      args,
      condition,
      options: {
        intervalSeconds: intervalSec,
        timeoutSeconds: timeoutSec,
        maxRetries,
        description: options.description,
      },
      status: "running",
      createdAt: now,
      startedAt: now,
      deadline,
      attempts: 0,
      consecutiveErrors: 0,
      notified: false,
    };

    this.records.set(id, record);
    if (!this.sessionMonitors.has(sessionId)) {
      this.sessionMonitors.set(sessionId, new Set());
    }
    this.sessionMonitors.get(sessionId)!.add(id);

    // Prune old records if exceeding max stored per session
    this.pruneSessionRecords(sessionId);

    // Cancel any pending clear-widget timer for this session
    const clearTimer = this.clearWidgetTimers.get(sessionId);
    if (clearTimer) {
      clearTimeout(clearTimer);
      this.clearWidgetTimers.delete(sessionId);
    }

    // Independent hard deadline timer
    const dlTimer = setTimeout(() => {
      this.handleDeadlineTimeout(id, record.generation);
    }, timeoutSec * 1000);
    this.deadlineTimers.set(id, dlTimer);

    // Update UI immediately to show the running card
    this.updateUI(sessionId);

    // Schedule initial check
    const initialTimer = setTimeout(() => {
      this.timers.delete(id);
      void this.pollStep(id);
    }, 500);
    this.timers.set(id, initialTimer);

    return record;
  }

  private handleDeadlineTimeout(id: string, generation: number): void {
    const record = this.records.get(id);
    if (!record || record.status !== "running" || record.generation !== generation) {
      return;
    }
    this.finishRecord(record, "timed_out", `Hard timeout reached (${record.options.timeoutSeconds}s)`);
  }

  public cancel(id: string, reason = "User or agent requested cancellation", requestingSessionId?: string): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== "running") {
      return false;
    }

    if (requestingSessionId && record.sessionId !== requestingSessionId) {
      return false;
    }

    record.status = "cancelled";
    record.terminalReason = reason;
    record.completedAt = Date.now();
    record.notified = true; // Suppress notification on explicit cancellation
    record.generation++; // Invalidate any in-flight step

    // Abort any in-flight execution
    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    // Clear timers
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    const dlTimer = this.deadlineTimers.get(id);
    if (dlTimer) {
      clearTimeout(dlTimer);
      this.deadlineTimers.delete(id);
    }

    this.inFlight.set(id, false);

    // Update UI immediately with cancelled status
    this.updateUI(record.sessionId);

    // Smooth UI cleanup after 20s if no active monitors
    this.checkScheduleWidgetCleanup(record.sessionId);

    return true;
  }

  public cancelSession(sessionId: string, reason = "Monitoring cancelled on session reset or switch"): void {
    const records = this.getSessionRecords(sessionId);
    for (const r of records) {
      if (r.status === "running") {
        this.cancel(r.id, reason, sessionId);
      }
    }
  }

  public pruneSession(sessionId: string): void {
    this.cancelSession(sessionId, "Monitoring cleaned up on session shutdown");
    const ids = this.sessionMonitors.get(sessionId);
    if (ids) {
      for (const id of ids) {
        const dlTimer = this.deadlineTimers.get(id);
        if (dlTimer) {
          clearTimeout(dlTimer);
          this.deadlineTimers.delete(id);
        }
        const timer = this.timers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(id);
        }
        this.records.delete(id);
        this.inFlight.delete(id);
        this.abortControllers.delete(id);
      }
      this.sessionMonitors.delete(sessionId);
    }
    const clearTimer = this.clearWidgetTimers.get(sessionId);
    if (clearTimer) {
      clearTimeout(clearTimer);
      this.clearWidgetTimers.delete(sessionId);
    }
    this.uiContexts.delete(sessionId);
    this.toolContexts.delete(sessionId);
  }

  private async pollStep(id: string): Promise<void> {
    try {
      const record = this.records.get(id);
      if (!record || record.status !== "running") {
        return;
      }

      const currentGen = record.generation;
      const now = Date.now();

      // Check hard deadline
      if (now >= record.deadline) {
        this.finishRecord(record, "timed_out", `Hard timeout reached (${record.options.timeoutSeconds}s)`);
        return;
      }

      // Single in-flight lock
      if (this.inFlight.get(id)) {
        return;
      }

      this.inFlight.set(id, true);
      record.attempts++;
      record.lastCheckedAt = now;

      const controller = new AbortController();
      this.abortControllers.set(id, controller);

      const targetCtx = this.toolContexts.get(record.sessionId) ?? this.uiContexts.get(record.sessionId);
      const executionOptions: ToolExecutionOptions = {
        signal: controller.signal,
        parentToolCallId: "pi-monitor:" + record.id,
      };

      let queryResult: { content: string; structuredContent?: unknown; isError: boolean; errorText?: string };
      try {
        queryResult = await this.toolExecutor(record.tool, record.args, executionOptions, targetCtx);
      } catch (err: unknown) {
        // If aborted locally by cancel/timeout
        if (controller.signal.aborted || record.status !== "running" || record.generation !== currentGen) {
          return;
        }
        queryResult = {
          content: "",
          isError: true,
          errorText: err instanceof Error ? err.message : String(err),
        };
      } finally {
        this.inFlight.set(id, false);
        this.abortControllers.delete(id);
      }

      // CRITICAL: Double check generation and status after async call
      // Strictly discard late results if status changed, timeout occurred, or generation advanced!
      if (
        record.status !== "running" ||
        record.generation !== currentGen ||
        Date.now() >= record.deadline ||
        !this.sessionMonitors.has(record.sessionId)
      ) {
        return;
      }

      // Safe truncate result content to 4KB
      if (queryResult.content && queryResult.content.length > MAX_CONTENT_LENGTH) {
        queryResult.content = queryResult.content.slice(0, MAX_CONTENT_LENGTH) + " ...[truncated]";
      }
      record.lastResult = queryResult;

      // Handle execution errors with bounded backoff retry
      if (queryResult.isError) {
        record.consecutiveErrors++;
        if (record.consecutiveErrors > record.options.maxRetries) {
          const errDetail = queryResult.errorText ? `: ${queryResult.errorText}` : "";
          this.finishRecord(record, "failed", `Consecutive errors (${record.consecutiveErrors}) exceeded retry limit${errDetail}`);
          return;
        }

        // Retry backoff: ensure not less than intervalSeconds
        const backoffSec = Math.max(
          record.options.intervalSeconds,
          Math.min(30, record.options.intervalSeconds * Math.pow(1.5, record.consecutiveErrors))
        );
        this.updateUI(record.sessionId);
        this.scheduleNext(id, currentGen, backoffSec * 1000);
        return;
      }

      // Execution succeeded, reset consecutive errors
      record.consecutiveErrors = 0;

      // Evaluate match condition
      const match = matchesCondition(record.condition, queryResult);
      if (match.matched) {
        this.finishRecord(record, "completed", match.reason ?? "Configured condition matched");
        return;
      }

      // Condition not yet met: schedule next routine check
      this.updateUI(record.sessionId);
      this.scheduleNext(id, currentGen, record.options.intervalSeconds * 1000);
    } catch (unexpectedError) {
      console.error("[pi-monitor] unexpected error in pollStep:", unexpectedError);
    }
  }

  private scheduleNext(id: string, generation: number, delayMs: number): void {
    const record = this.records.get(id);
    if (!record || record.status !== "running" || record.generation !== generation) return;

    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.pollStep(id);
    }, delayMs);
    this.timers.set(id, timer);
  }

  private finishRecord(record: MonitorRecord, status: "completed" | "failed" | "timed_out", reason: string): void {
    if (record.status !== "running") return;

    record.status = status;
    record.terminalReason = reason;
    record.completedAt = Date.now();
    record.generation++; // Invalidate pending steps

    // Abort controller and timers cleanup
    const controller = this.abortControllers.get(record.id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(record.id);
    }
    const timer = this.timers.get(record.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(record.id);
    }
    const dlTimer = this.deadlineTimers.get(record.id);
    if (dlTimer) {
      clearTimeout(dlTimer);
      this.deadlineTimers.delete(record.id);
    }
    this.inFlight.set(record.id, false);

    // Update UI immediately with final state
    this.updateUI(record.sessionId);

    // Send notification and wake model if not already notified
    if (!record.notified) {
      record.notified = true;
      this.notifyCompletion(record);
    }

    // Schedule 20s smooth widget card cleanup
    this.checkScheduleWidgetCleanup(record.sessionId);
  }

  private checkScheduleWidgetCleanup(sessionId: string): void {
    const sessionRecords = this.getSessionRecords(sessionId);
    const hasRunning = sessionRecords.some(r => r.status === "running");
    if (!hasRunning) {
      // Clear status shelf buttons immediately
      const uiCtx = this.uiContexts.get(sessionId);
      if (uiCtx?.hasUI) {
        for (const r of sessionRecords) {
          uiCtx.ui.setStatus(`command:/monitor_cancel ${r.id}`, undefined);
        }
      }

      // Linger widget card for 20 seconds so user sees final state, then clear
      const existingClear = this.clearWidgetTimers.get(sessionId);
      if (existingClear) clearTimeout(existingClear);

      const clearTimer = setTimeout(() => {
        this.clearWidgetTimers.delete(sessionId);
        const currentCtx = this.uiContexts.get(sessionId);
        const currentRecords = this.getSessionRecords(sessionId);
        if (!currentRecords.some(r => r.status === "running")) {
          currentCtx?.ui.setWidget(WIDGET_KEY, undefined);
        }
      }, 20000);
      this.clearWidgetTimers.set(sessionId, clearTimer);
    }
  }

  private notifyCompletion(record: MonitorRecord): void {
    if (!this.pi) return;

    const summary = formatCompletionNotification(record);
    const uiCtx = this.uiContexts.get(record.sessionId);

    this.pi.sendMessage(
      {
        customType: NOTIFICATION_CUSTOM_TYPE,
        content: summary,
        display: true,
        details: {
          monitorId: record.id,
          tool: record.tool,
          status: record.status,
          durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
          attempts: record.attempts,
        },
      },
      { deliverAs: "followUp", triggerTurn: true }
    );

    if (uiCtx?.hasUI) {
      const label = record.options.description || record.tool;
      const notifyType = record.status === "completed" ? "info" : "warning";
      uiCtx.ui.notify(
        `[Pi-Monitor] ${label}: ${record.status}`,
        notifyType
      );
    }
  }

  public updateUI(sessionId: string): void {
    const ctx = this.uiContexts.get(sessionId);
    if (!ctx?.hasUI) return;

    const records = this.getSessionRecords(sessionId);
    if (records.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }

    // 1. Update widget lines above editor
    const widgetLines = formatWidgetLines(records);
    ctx.ui.setWidget(WIDGET_KEY, widgetLines, { placement: "aboveEditor" });

    // Clear legacy UI actions; cancellation remains available to the agent.
    for (const r of records) {
      ctx.ui.setStatus(`command:/monitor_cancel ${r.id}`, undefined);
    }
  }
}
