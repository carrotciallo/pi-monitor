import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NotificationOutbox } from "./notifications.ts";
import { formatInterruptionNotice, formatWidgetLines } from "./formatter.ts";
import { observeDisplayValues } from "./display.ts";
import { formatLostMonitorNotice } from "./lifecycle.ts";
import { canonicalJson, computeSha256, matchesCondition, observeConditionValue, validateMonitorSample } from "./matcher.ts";
import { sanitizeValue } from "./privacy.ts";
import { classifyFailure } from "./error-classification.ts";
import {
  DEFAULT_CONSECUTIVE_MATCHES,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_STABLE_FOR_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_CONSECUTIVE_MATCHES,
  MAX_CONCURRENT_MONITORS,
  MAX_CONTENT_LENGTH,
  MAX_INTERVAL_SECONDS,
  MAX_STABLE_FOR_SECONDS,
  MAX_STORED_RECORDS_PER_SESSION,
  MAX_TIMEOUT_SECONDS,
  MIN_INTERVAL_SECONDS,
  STATE_ENTRY_TYPE,
  type CancelKind,
  type MonitorCondition,
  type MonitorOptions,
  type MonitorPersistEntry,
  type MonitorRecord,
  type MonitorStatus,
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

export interface StartResult {
  record: MonitorRecord;
  reused: boolean;
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
  /** In-memory index of persisted monitor lifecycle records, per session. */
  private persisted = new Map<string, Map<string, MonitorPersistEntry>>();
  /** Monitor ids already surfaced as interrupted for the current session. */
  private interruptionNotified = new Set<string>();
  /** Monitor ids already surfaced as lost (running with no live record). */
  private lostNotified = new Set<string>();

  constructor(toolExecutor: ToolExecutor, pi?: ExtensionAPI) {
    this.toolExecutor = toolExecutor;
    if (pi) this.setExtensionAPI(pi);
  }

  public notifications?: NotificationOutbox;

  public setExtensionAPI(pi: ExtensionAPI): void {
    this.pi = pi;
    this.notifications = new NotificationOutbox(pi, receipt => {
      const record = this.records.get(receipt.monitorId);
      if (!record) return;
      record.notificationDelivery = receipt.delivery;
      record.notificationWake = receipt.wake;
      record.notified = receipt.delivery === "persisted";
      record.notificationError = receipt.delivery === "delivery_unknown"
        ? "Notification delivery is unconfirmed; automatic retry suppressed to avoid duplicate wake-ups"
        : receipt.wake === "unconfirmed" ? "Notification persisted; wake is unconfirmed" : undefined;
      this.updateUI(record.sessionId);
      this.checkScheduleWidgetCleanup(record.sessionId);
    });
  }

  public registerContext(sessionId: string, ctx: ExtensionContext): void {
    this.registerUIContext(sessionId, ctx);
    this.registerToolContext(sessionId, ctx);
  }

  public registerUIContext(sessionId: string, ctx: ExtensionContext): void {
    this.uiContexts.set(sessionId, ctx);
    this.notifications?.bind(ctx);
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
      this.releaseRecord(oldest.id);
    }
  }

  /** Drop every index owned by a record, not just the public record. */
  private releaseRecord(id: string): void {
    const record = this.records.get(id);
    this.clearTimer(id);
    this.abortControllers.get(id)?.abort();
    this.abortControllers.delete(id);
    this.inFlight.delete(id);
    this.records.delete(id);
    this.interruptionNotified.delete(id);
    this.lostNotified.delete(id);
    if (record) {
      this.sessionMonitors.get(record.sessionId)?.delete(id);
      this.persisted.get(record.sessionId)?.delete(id);
    }
  }

  private trimPersisted(sessionId: string): void {
    const entries = this.persisted.get(sessionId);
    if (!entries) return;
    while (entries.size > MAX_STORED_RECORDS_PER_SESSION) {
      const id = entries.keys().next().value;
      if (id === undefined) break;
      entries.delete(id);
      this.lostNotified.delete(id);
      this.interruptionNotified.delete(id);
    }
  }

  /** UI is optional: a broken renderer must never stop polling or delivery. */
  private safeUI(action: () => void): void {
    try { action(); } catch {
      console.error("[pi-monitor] UI update failed; monitoring state is unaffected");
    }
  }

  /**
   * Persist a durable, non-context lifecycle record for the active branch. The
   * record never contains raw tool arguments or results. Best effort: missing
   * host support is ignored, since in-memory state remains authoritative.
   */
  private persist(record: MonitorRecord, event: MonitorPersistEntry["event"], reason?: string): void {
    const entry: MonitorPersistEntry = {
      version: 2,
      monitorId: record.id,
      event,
      tool: record.tool,
      argsHash: safeArgsHash(record.args),
      options: { ...record.options, description: undefined },
      status: record.status,
      createdAt: record.createdAt,
      terminalAt: record.completedAt,
      // User conditions, descriptions, tool errors and interruption text may
      // contain secrets. Persist only the fixed lifecycle event classification.
      reason: reason === undefined ? undefined : event,
      attempts: record.attempts,
      interruptedBy: record.interruptedBy === undefined ? undefined : "lifecycle-change",
    };
    const sessionMap = this.persisted.get(record.sessionId) ?? new Map<string, MonitorPersistEntry>();
    sessionMap.delete(record.id);
    sessionMap.set(record.id, entry);
    this.persisted.set(record.sessionId, sessionMap);
    this.trimPersisted(record.sessionId);
    if (this.pi && typeof this.pi.appendEntry === "function") {
      try {
        this.pi.appendEntry(STATE_ENTRY_TYPE, entry);
      } catch {
        // Persistence is best effort; never fail a monitor because of it.
      }
    }
  }

  /**
   * Reconstruct known monitor lifecycle from the active branch only. Returns
   * descriptors that were started but never reached a terminal state (lost on
   * reload) and descriptors that were interrupted. No execution is restored.
   * Deduplicates a monitor's entries by keeping its latest terminal/created time.
   */
  public reconcilePersisted(
    sessionId: string,
    entries: readonly unknown[]
  ): { lost: MonitorPersistEntry[]; interrupted: MonitorPersistEntry[] } {
    const latest = new Map<string, MonitorPersistEntry>();
    for (const raw of entries) {
      const entry = raw as { type?: string; customType?: string; data?: unknown };
      if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
      const data = entry.data as MonitorPersistEntry | undefined;
      if (!data || (data.version !== 1 && data.version !== 2) || typeof data.monitorId !== "string") continue;
      const previous = latest.get(data.monitorId);
      if (!previous || (data.terminalAt ?? data.createdAt) >= (previous.terminalAt ?? previous.createdAt)) {
        latest.set(data.monitorId, data);
      }
    }
    for (const id of this.persisted.get(sessionId)?.keys() ?? []) {
      if (!latest.has(id) && !this.records.has(id)) {
        this.lostNotified.delete(id);
        this.interruptionNotified.delete(id);
      }
    }
    this.persisted.set(sessionId, latest);
    this.trimPersisted(sessionId);

    const live = new Set(this.getSessionRecords(sessionId).map(r => r.id));
    const lost: MonitorPersistEntry[] = [];
    const interrupted: MonitorPersistEntry[] = [];
    for (const data of latest.values()) {
      // A descriptor backed by a live in-memory record is not a reload artifact.
      if (live.has(data.monitorId)) {
        continue;
      }
      if (data.status === "running") lost.push(data);
      else if (data.status === "interrupted") interrupted.push(data);
    }
    return { lost, interrupted };
  }

  /**
   * Claim lost descriptors that have not been reported yet in this runtime and
   * surface them in the UI. Returns the notice text for non-UI delivery.
   * Missing host persistence degrades to an empty list.
   */
  public notifyLost(sessionId: string, lost: readonly MonitorPersistEntry[]): string | undefined {
    const fresh = lost.filter(e => !this.lostNotified.has(e.monitorId));
    for (const e of fresh) this.lostNotified.add(e.monitorId);
    if (fresh.length === 0) return undefined;
    const notice = formatLostMonitorNotice(fresh);
    const ctx = this.uiContexts.get(sessionId);
    if (notice && ctx?.hasUI) {
      this.safeUI(() => ctx.ui.notify(notice, "warning"));
    }
    return notice;
  }

  /**
   * Surface a resume notice for monitors interrupted during this session or in
   * the active branch. Covers both live interrupted records (runtime) and
   * persisted interrupted descriptors (reload), so an interruption never
   * disappears silently. Returns the notice text for non-UI delivery.
   */
  public notifyInterruptions(sessionId: string, _reason = "a session or branch change"): string | undefined {
    const notices: string[] = [];

    const live = this.getSessionRecords(sessionId).filter(
      r => r.status === "interrupted" && !this.interruptionNotified.has(r.id)
    );
    for (const r of live) this.interruptionNotified.add(r.id);
    if (live.length > 0) {
      const notice = formatInterruptionNotice(live.map(r => ({
        id: r.id,
        options: { description: r.options.description },
      })));
      if (notice) notices.push(notice);
    }

    const persisted = this.persisted.get(sessionId);
    if (persisted) {
      const stale = Array.from(persisted.values()).filter(
        e => e.status === "interrupted" && !this.interruptionNotified.has(e.monitorId)
      );
      for (const e of stale) this.interruptionNotified.add(e.monitorId);
      if (stale.length > 0) {
        const notice = formatInterruptionNotice(stale.map(e => ({
          id: e.monitorId,
          options: { description: e.options?.description },
        })));
        if (notice) notices.push(notice);
      }
    }

    if (notices.length === 0) return undefined;
    const combined = notices.join("\n");
    const ctx = this.uiContexts.get(sessionId);
    if (ctx?.hasUI) {
      this.safeUI(() => ctx.ui.notify(combined, "warning"));
    }
    return combined;
  }

  public startMonitor(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    condition: MonitorCondition,
    options: MonitorOptions = {},
    ctx?: ExtensionContext
  ): MonitorRecord {
    return this.startOrReuseMonitor(sessionId, tool, args, condition, options, ctx).record;
  }

  /**
   * Start a monitor, or reuse an existing identical running monitor in the same
   * session. Identity uses the tool name, canonical JSON arguments, canonical
   * condition and the full polling/stability configuration. `description` is a
   * label and does not affect identity.
   */
  public startOrReuseMonitor(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    condition: MonitorCondition,
    options: MonitorOptions = {},
    ctx?: ExtensionContext
  ): StartResult {
    if (ctx) {
      this.registerContext(sessionId, ctx);
    }

    const intervalSec = clamp(options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
    const timeoutSec = clamp(options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MIN_INTERVAL_SECONDS * 2, MAX_TIMEOUT_SECONDS);
    const maxRetries = Math.max(0, Math.min(10, options.maxRetries ?? DEFAULT_MAX_RETRIES));
    const consecutiveMatches = clamp(
      options.consecutiveMatches ?? DEFAULT_CONSECUTIVE_MATCHES, 1, MAX_CONSECUTIVE_MATCHES
    );
    const stableForSeconds = clamp(
      options.stableForSeconds ?? DEFAULT_STABLE_FOR_SECONDS, 0, MAX_STABLE_FOR_SECONDS
    );
    const display = options.display;

    let identity: string;
    try {
      identity = canonicalJson({ tool, args, condition, display, intervalSec, timeoutSec, maxRetries, consecutiveMatches, stableForSeconds });
    } catch (err) {
      throw new Error(`Cannot start monitor: arguments are not canonical JSON (${err instanceof Error ? err.message : String(err)})`);
    }

    // Exact dedupe: reuse an existing running monitor with identical identity.
    for (const existing of this.getSessionRecords(sessionId)) {
      if (existing.status !== "running") continue;
      let existingIdentity: string | null = null;
      try {
        existingIdentity = canonicalJson({
          tool: existing.tool,
          args: existing.args,
          condition: existing.condition,
          display: existing.display,
          intervalSec: existing.options.intervalSeconds,
          timeoutSec: existing.options.timeoutSeconds,
          maxRetries: existing.options.maxRetries,
          consecutiveMatches: existing.options.consecutiveMatches,
          stableForSeconds: existing.options.stableForSeconds,
        });
      } catch {
        existingIdentity = null;
      }
      if (existingIdentity === identity) {
        return { record: existing, reused: true };
      }
    }

    if (this.notifications && !this.notifications.hasCapacity(sessionId)) {
      throw new Error("Notification outbox is full; review /monitor-delivery before starting more monitors");
    }
    // Check concurrency limit for running monitors in this session
    const existingRecords = this.getSessionRecords(sessionId);
    const runningCount = existingRecords.filter(r => r.status === "running").length;
    if (runningCount >= MAX_CONCURRENT_MONITORS) {
      throw new Error(`Exceeded maximum concurrent monitors limit (${MAX_CONCURRENT_MONITORS}) for session ${sessionId}`);
    }

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
        consecutiveMatches,
        stableForSeconds,
        description: options.description,
      },
      ...(display ? { display } : {}),
      status: "running",
      createdAt: now,
      startedAt: now,
      deadline,
      attempts: 0,
      consecutiveErrors: 0,
      consecutiveMatches: 0,
      notified: false,
    };

    this.records.set(id, record);
    if (!this.sessionMonitors.has(sessionId)) {
      this.sessionMonitors.set(sessionId, new Set());
    }
    this.sessionMonitors.get(sessionId)!.add(id);
    this.interruptionNotified.delete(id);

    // Prune old records if exceeding max stored per session
    this.pruneSessionRecords(sessionId);

    // Durable running descriptor so reload-lost monitors can be reported.
    this.persist(record, "started");

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

    // Schedule initial check, then update the UI so nextCheckAt is current.
    record.nextCheckAt = now + 500;
    const initialTimer = setTimeout(() => {
      this.timers.delete(id);
      void this.pollStep(id);
    }, 500);
    this.timers.set(id, initialTimer);

    // Update UI immediately to show the running card
    this.updateUI(sessionId);

    return { record, reused: false };
  }

  private handleDeadlineTimeout(id: string, generation: number): void {
    const record = this.records.get(id);
    if (!record || record.status !== "running" || record.generation !== generation) {
      return;
    }
    this.finishRecord(record, "timed_out", `Hard timeout reached (${record.options.timeoutSeconds}s)`);
  }

  public cancel(
    id: string,
    reason = "User or agent requested cancellation",
    requestingSessionId?: string,
    kind: CancelKind = "explicit",
    persist = true
  ): boolean {
    const record = this.records.get(id);
    if (!record || record.status !== "running") {
      return false;
    }

    if (requestingSessionId && record.sessionId !== requestingSessionId) {
      return false;
    }

    record.status = kind === "interrupted" ? "interrupted" : "cancelled";
    record.terminalReason = reason;
    record.interruptedBy = kind === "interrupted" ? reason : undefined;
    record.completedAt = Date.now();
    record.notified = false;
    record.notificationDelivery = "suppressed"; // Cancellation is not delivery.
    record.generation++; // Invalidate any in-flight step

    // Abort any in-flight execution
    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    // Clear timers
    this.clearTimer(id);
    this.inFlight.delete(id);
    record.nextCheckAt = undefined;

    // Post-tree interruption must not append old-branch state to the new branch.
    if (persist) this.persist(record, record.status, reason);
    this.updateUI(record.sessionId);

    // Smooth UI cleanup after 20s if no active monitors
    this.checkScheduleWidgetCleanup(record.sessionId);

    return true;
  }

  private clearTimer(id: string): void {
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
  }

  public cancelSession(sessionId: string, reason = "Monitoring cancelled on session reset or switch"): void {
    this.interruptSession(sessionId, reason);
  }

  /** Interrupt every running monitor for a session due to a lifecycle change. */
  public interruptSession(sessionId: string, reason: string, persist = true): void {
    const records = this.getSessionRecords(sessionId);
    for (const r of records) {
      if (r.status === "running") {
        this.cancel(r.id, reason, sessionId, "interrupted", persist);
      }
    }
  }

  public pruneSession(sessionId: string): void {
    this.notifications?.close(sessionId);
    this.cancelSession(sessionId, "Monitoring cleaned up on session shutdown");
    const ids = this.sessionMonitors.get(sessionId);
    if (ids) {
      for (const id of ids) {
        this.releaseRecord(id);
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
    for (const id of this.persisted.get(sessionId)?.keys() ?? []) {
      this.lostNotified.delete(id);
      this.interruptionNotified.delete(id);
    }
    this.persisted.delete(sessionId);
  }

  /**
   * Build a concise notice text for the given lifecycle observations. Used by
   * non-UI delivery (for example the `nextTurn` context message), so an
   * interruption is never silent when there is no UI.
   */
  public buildLifecycleNotice(
    lost: readonly MonitorPersistEntry[],
    interruptedNotice: string | undefined
  ): string | undefined {
    const parts: string[] = [];
    const lostNotice = formatLostMonitorNotice(lost);
    if (lostNotice) parts.push(lostNotice);
    if (interruptedNotice) parts.push(interruptedNotice);
    return parts.length > 0 ? parts.join("\n") : undefined;
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
      record.lastAttemptAt = now;
      record.lastCheckedAt = now;

      const controller = new AbortController();
      this.abortControllers.set(id, controller);

      const targetCtx = this.toolContexts.get(record.sessionId) ?? this.uiContexts.get(record.sessionId);
      const executionOptions: ToolExecutionOptions = {
        signal: controller.signal,
        parentToolCallId: "pi-monitor:" + record.id,
      };

      let queryResult: { content: string; structuredContent?: unknown; isError: boolean; errorText?: string; toolName?: string };
      try {
        const outcome = await this.toolExecutor(record.tool, record.args, executionOptions, targetCtx);
        queryResult = { ...outcome, toolName: record.tool };
      } catch (err: unknown) {
        // If aborted locally by cancel/timeout
        if (controller.signal.aborted || record.status !== "running" || record.generation !== currentGen) {
          return;
        }
        queryResult = {
          content: "",
          isError: true,
          errorText: err instanceof Error ? err.message : String(err),
          toolName: record.tool,
        };
      } finally {
        // Deletion cannot resurrect state after pruning a late execution.
        this.inFlight.delete(id);
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

      if (!queryResult.isError) {
        try {
          validateMonitorSample(queryResult);
        } catch (error) {
          queryResult = { content: "", isError: true, toolName: record.tool,
            errorText: `Invalid monitor sample: ${error instanceof Error ? error.message : "validation failed"}` };
        }
      }
      // Keep a bounded projection, but match against the complete sample below.
      record.lastResult = {
        ...queryResult,
        content: queryResult.content.slice(0, MAX_CONTENT_LENGTH),
        structuredContent: sanitizeValue("structuredContent", queryResult.structuredContent),
        errorText: queryResult.errorText?.slice(0, 200),
      };

      // Handle execution errors with bounded backoff retry.
      // Errors are not observed samples: they reset match progress and clear the
      // last observed field value so a stale value never looks current.
      if (queryResult.isError) {
        record.consecutiveErrors++;
        record.lastErrorAt = Date.now();
        record.lastErrorText = queryResult.errorText ? queryResult.errorText.slice(0, 200) : undefined;
        record.consecutiveMatches = 0;
        record.firstMatchAt = undefined;
        record.lastObservedValue = undefined;
        record.displayValues = undefined;
        const failureClass = classifyFailure(queryResult.errorText ?? queryResult.content);
        if (failureClass === "policy_denied" || failureClass === "tool_unavailable") {
          record.lastErrorText = failureClass;
          this.finishRecord(record, "failed", `Non-retryable query failure: ${failureClass}`);
          return;
        }
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
        this.scheduleNext(id, currentGen, backoffSec * 1000);
        return;
      }

      // Execution succeeded
      record.consecutiveErrors = 0;
      record.lastErrorText = undefined;
      record.lastSuccessAt = Date.now();

      // Evaluate match condition
      const match = matchesCondition(record.condition, queryResult);
      // Project the declared display fields from the same successful sample. A
      // field that disappeared clears the segment rather than leaving a stale
      // reading, matching the observed-value semantics below.
      record.displayValues = observeDisplayValues(record.display, queryResult);
      const observed = observeConditionValue(record.condition, queryResult);
      // Update or clear the observed value: a field that disappeared on a
      // successful sample must not leave a stale value on screen.
      record.lastObservedValue = observed ? { ...observed, matched: match.matched } : undefined;

      if (match.matched) {
        if (record.consecutiveMatches === 0 || record.firstMatchAt === undefined) {
          record.firstMatchAt = Date.now();
        }
        record.consecutiveMatches++;

        const required = record.options.consecutiveMatches;
        const stableMs = record.options.stableForSeconds * 1000;
        const stableElapsed = Date.now() - (record.firstMatchAt ?? Date.now());
        if (record.consecutiveMatches >= required && stableElapsed >= stableMs) {
          const detail = required > 1 || record.options.stableForSeconds > 0
            ? `${match.reason ?? "Condition matched"} (stable: ${record.consecutiveMatches}/${required} matches, ${Math.floor(stableElapsed / 1000)}s)`
            : match.reason ?? "Configured condition matched";
          this.finishRecord(record, "completed", detail);
          return;
        }

        // Matched but stability not yet satisfied; keep waiting.
        this.scheduleNext(id, currentGen, record.options.intervalSeconds * 1000);
        return;
      }

      // Observed miss: reset stability progress.
      record.consecutiveMatches = 0;
      record.firstMatchAt = undefined;

      // Condition not yet met: schedule next routine check.
      this.scheduleNext(id, currentGen, record.options.intervalSeconds * 1000);
    } catch {
      // Never leave a running record with no next check. Do not log raw tool
      // exceptions here: they may contain arguments or credentials.
      const record = this.records.get(id);
      if (record?.status === "running") {
        this.finishRecord(record, "failed", "Internal sample processing failed; monitoring stopped safely");
      }
    }
  }

  private scheduleNext(id: string, generation: number, delayMs: number): void {
    const record = this.records.get(id);
    if (!record || record.status !== "running" || record.generation !== generation) return;

    record.nextCheckAt = Date.now() + delayMs;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.pollStep(id);
    }, delayMs);
    this.timers.set(id, timer);
    // Refresh the UI after nextCheckAt is set so the health line is current.
    this.updateUI(record.sessionId);
  }

  private finishRecord(record: MonitorRecord, status: "completed" | "failed" | "timed_out", reason: string): void {
    if (record.status !== "running") return;

    record.status = status;
    record.terminalReason = reason;
    record.completedAt = Date.now();
    record.nextCheckAt = undefined;
    record.generation++; // Invalidate pending steps

    // Abort controller and timers cleanup
    const controller = this.abortControllers.get(record.id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(record.id);
    }
    this.clearTimer(record.id);
    this.inFlight.delete(record.id);

    this.persist(record, status, reason);

    // Update UI immediately with final state
    this.updateUI(record.sessionId);

    // Send notification and wake model if not already notified
    if (!record.notified) this.notifyCompletion(record);

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
          this.safeUI(() => uiCtx.ui.setStatus(`command:/monitor_cancel ${r.id}`, undefined));
        }
      }

      // Linger widget card for 20 seconds so user sees final state, then clear
      const existingClear = this.clearWidgetTimers.get(sessionId);
      if (existingClear) clearTimeout(existingClear);

      const clearTimer = setTimeout(() => {
        this.clearWidgetTimers.delete(sessionId);
        const currentCtx = this.uiContexts.get(sessionId);
        const currentRecords = this.getSessionRecords(sessionId);
        const unresolved = this.notifications?.list(sessionId).some(r =>
          r.delivery !== "persisted" || r.wake === "submitted" || r.wake === "unconfirmed");
        if (!currentRecords.some(r => r.status === "running") && !unresolved) {
          if (currentCtx?.hasUI) this.safeUI(() => currentCtx.ui.setWidget(WIDGET_KEY, undefined));
        }
      }, 20000);
      this.clearWidgetTimers.set(sessionId, clearTimer);
    }
  }

  private notifyCompletion(record: MonitorRecord): void {
    const uiCtx = this.uiContexts.get(record.sessionId);
    if (this.notifications) this.notifications.enqueue(record);
    else {
      record.notificationDelivery = "delivery_unknown";
      record.notificationError = "Notification API unavailable";
    }

    if (uiCtx?.hasUI) {
      const label = record.options.description || record.tool;
      const notifyType = record.status === "completed" ? "info" : "warning";
      this.safeUI(() => uiCtx.ui.notify(
        `[Pi-Monitor] ${label}: ${record.status}${record.notificationError ? ` — ${record.notificationError}` : ""}`,
        record.notificationError ? "warning" : notifyType
      ));
    }
  }

  public updateUI(sessionId: string): void {
    this.safeUI(() => this.renderUI(sessionId));
  }

  private renderUI(sessionId: string): void {
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Canonical digest of tool arguments; never stores the raw arguments. */
function safeArgsHash(args: Record<string, unknown>): string {
  try {
    return computeSha256(args);
  } catch {
    return "[unhashable]";
  }
}

export type { MonitorStatus };
