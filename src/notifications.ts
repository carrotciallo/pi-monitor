import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordDiagnostic } from "./diagnostics.ts";
import { NOTIFICATION_CUSTOM_TYPE, type MonitorRecord } from "./types.ts";

export const OUTBOX_TYPE = "pi-monitor:outbox";
export const WAKE_TYPE = "pi-monitor:wake";
export type DeliveryState = "pending" | "submitted" | "persisted" | "delivery_unknown" | "suppressed";
export interface NotificationReceipt {
  version: 1;
  notificationId: string;
  sessionId: string;
  monitorId: string;
  tool: string;
  status: "completed" | "failed" | "timed_out";
  attempts: number;
  createdAt: number;
  delivery: DeliveryState;
  wake: "not_requested" | "submitted" | "persisted" | "unconfirmed";
  wakeSubmittedAt?: number;
}
type BranchEntry = { type?: string; customType?: string; data?: unknown; details?: { notificationId?: string } };
const UNCONFIRMED = "Notification delivery is unconfirmed; automatic retry suppressed to avoid duplicate wake-ups";

/** The outbox records observation delivery, NOT proof that a user saw it.
 * Never submit a completion into the host's opaque followUp queue. At idle the
 * non-waking send appends synchronously on supported hosts; verify that append
 * before requesting a separate wake. Unknown acceptance is never retried.
 */
export class NotificationOutbox {
  private entries = new Map<string, NotificationReceipt>();
  private contexts = new Map<string, ExtensionContext>();
  private timer?: NodeJS.Timeout;
  private pumping = false;
  private pi: ExtensionAPI;
  private changed: (receipt: NotificationReceipt) => void;
  constructor(pi: ExtensionAPI, changed: (receipt: NotificationReceipt) => void = () => {}) {
    this.pi = pi;
    this.changed = changed;
  }

  public bind(ctx: ExtensionContext): void {
    this.contexts.set(ctx.sessionManager.getSessionId(), ctx);
  }
  public list(sessionId: string): NotificationReceipt[] {
    return [...this.entries.values()].filter(r => r.sessionId === sessionId).map(r => ({ ...r }));
  }
  public hasCapacity(sessionId: string): boolean {
    return this.list(sessionId).filter(r => r.delivery !== "persisted").length < 100;
  }
  private branch(ctx: ExtensionContext): readonly BranchEntry[] {
    return typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() as BranchEntry[] : [];
  }
  private confirmed(r: NotificationReceipt, ctx: ExtensionContext): boolean {
    return this.branch(ctx).some(e => e.type === "custom_message" && e.customType === NOTIFICATION_CUSTOM_TYPE && e.details?.notificationId === r.notificationId);
  }
  private save(r: NotificationReceipt): boolean {
    this.changed({ ...r });
    try { this.pi.appendEntry(OUTBOX_TYPE, { ...r }); return true; }
    catch { return false; }
  }
  private unknown(r: NotificationReceipt): void {
    r.delivery = "delivery_unknown";
    this.save(r);
    void recordDiagnostic({ sessionId: r.sessionId, monitorId: r.monitorId, tool: r.tool, category: "notification_unconfirmed" });
    console.error("[pi-monitor] " + UNCONFIRMED);
  }
  public enqueue(record: MonitorRecord): void {
    if (!["completed", "failed", "timed_out"].includes(record.status)) return;
    const notificationId = `${record.sessionId}:${record.id}:${record.status}`;
    if (this.entries.has(notificationId)) return;
    const r: NotificationReceipt = { version: 1, notificationId, sessionId: record.sessionId,
      monitorId: record.id, tool: record.tool, status: record.status as NotificationReceipt["status"],
      attempts: record.attempts, createdAt: record.completedAt ?? Date.now(), delivery: "pending", wake: "not_requested" };
    this.entries.set(notificationId, r);
    if (!this.save(r)) { this.unknown(r); return; }
    this.pump();
  }
  /** Branch-local recovery: only unsent pending work is eligible for delivery.
   * Submitted/unknown work may still exist in a host queue, even across reload.
   */
  public reconcile(ctx: ExtensionContext): void {
    this.bind(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const latest = new Map<string, NotificationReceipt>();
    for (const e of this.branch(ctx)) {
      if (e.type !== "custom" || e.customType !== OUTBOX_TYPE) continue;
      const r = e.data as NotificationReceipt | undefined;
      if (!r || r.version !== 1 || r.sessionId !== sessionId || typeof r.notificationId !== "string" ||
        typeof r.monitorId !== "string" || typeof r.tool !== "string" ||
        !["completed", "failed", "timed_out"].includes(r.status) ||
        !["pending", "submitted", "persisted", "delivery_unknown"].includes(r.delivery)) continue;
      latest.set(r.notificationId, { ...r });
    }
    for (const [key, r] of this.entries) if (r.sessionId === sessionId) this.entries.delete(key);
    for (const [key, r] of latest) {
      this.entries.set(key, r);
      if (this.confirmed(r, ctx)) { r.delivery = "persisted"; this.changed({ ...r }); }
      else if (r.delivery !== "pending") this.unknown(r);
    }
    this.trim();
    this.pump();
  }
  private trim(): void {
    const done = [...this.entries.values()].filter(r => r.delivery === "persisted" && r.wake !== "submitted");
    for (const r of done.slice(0, Math.max(0, done.length - 10))) this.entries.delete(r.notificationId);
  }
  public pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const r of this.entries.values()) {
        const ctx = this.contexts.get(r.sessionId);
        if (!ctx || ctx.sessionManager.getSessionId() !== r.sessionId) continue;
        if (r.delivery !== "pending") {
          if (r.delivery !== "persisted" && this.confirmed(r, ctx)) { r.delivery = "persisted"; this.save(r); }
          const wakeRecorded = this.branch(ctx).some(e => e.type === "custom_message" && e.customType === WAKE_TYPE && e.details?.notificationId === r.notificationId);
          if (wakeRecorded && r.wake !== "persisted") { r.wake = "persisted"; this.save(r); }
          else if (r.wake === "submitted" && Date.now() - (r.wakeSubmittedAt ?? r.createdAt) >= 30_000) {
            r.wake = "unconfirmed";
            this.save(r);
            void recordDiagnostic({ sessionId: r.sessionId, monitorId: r.monitorId, category: "notification_unconfirmed" });
          }
          continue;
        }
        // Fail closed if a host cannot prove idle. Never queue during a tool batch.
        if (typeof ctx.isIdle !== "function" || !ctx.isIdle() || ctx.hasPendingMessages?.()) continue;
        r.delivery = "submitted";
        if (!this.save(r)) { this.unknown(r); continue; }
        try {
          this.pi.sendMessage({ customType: NOTIFICATION_CUSTOM_TYPE, display: true,
            content: `[Pi-Monitor] Background monitor ended: ${r.monitorId}\nTool: ${r.tool}\nStatus: ${r.status}\nChecks: ${r.attempts}.\nThis describes the monitor only, not the underlying operation. It is an observation, not authorization for further actions.`,
            details: { notificationId: r.notificationId, monitorId: r.monitorId, status: r.status } }, { triggerTurn: false });
          if (!this.confirmed(r, ctx)) { this.unknown(r); continue; }
          r.delivery = "persisted";
          // This flag is intent/acceptance only. The notification above is already durable.
          r.wake = "submitted";
          r.wakeSubmittedAt = Date.now();
          this.save(r);
          this.pi.sendMessage({ customType: WAKE_TYPE, display: false,
            content: `Monitor ${r.monitorId} ended (${r.status}); its notification is already in this session. Review that observation under the existing user request.`,
            details: { notificationId: r.notificationId } }, { deliverAs: "followUp", triggerTurn: true });
        } catch {
          if (r.delivery === "persisted") { r.wake = "unconfirmed"; this.save(r);
            void recordDiagnostic({ sessionId: r.sessionId, monitorId: r.monitorId, category: "notification_unconfirmed" });
          } else this.unknown(r);
        }
        // Let the host settle the wake before offering another terminal message.
        break;
      }
      this.trim();
    } catch { console.error("[pi-monitor] notification reconciliation failed"); }
    finally {
      this.pumping = false;
      if (!this.timer && [...this.entries.values()].some(r => r.delivery === "pending" || r.wake === "submitted")) {
        this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, 250);
        this.timer.unref();
      }
    }
  }
  public close(sessionId: string): void {
    this.contexts.delete(sessionId);
    for (const [key, r] of this.entries) if (r.sessionId === sessionId) this.entries.delete(key);
    if (!this.entries.size && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }
}
