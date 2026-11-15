import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson } from "./matcher.ts";

const KEY = Symbol.for("pi-monitor.call-leases.v1");
interface Lease {
  monitorId: string;
  matches(sessionId: string, tool: string, args: unknown): boolean;
}
const CONTEXT_KEY = Symbol.for("pi-monitor.call-context.v1");
const AUTHORITY_KEY = Symbol.for("pi-monitor.call-authority.v2");
export interface MonitorIdentity { monitorId: string; requiresReadOnly?: boolean }
interface ScopedLease {
  monitorId: string;
  requiresReadOnly?: boolean;
  expiresAt: number;
  eventId?: string;
  consumers: Set<string>;
  matches(sessionId: string, tool: string, args: unknown): boolean;
}
interface MonitorAuthority {
  claim(consumer: string, sessionId: string, tool: string, args: unknown, eventId: string): MonitorIdentity | undefined;
}
const scopedLeases = new Map<string, ScopedLease>();
const shared = globalThis as typeof globalThis & {
  [KEY]?: Map<string, Lease>;
  [CONTEXT_KEY]?: AsyncLocalStorage<string>;
  [AUTHORITY_KEY]?: MonitorAuthority;
};
const leases = shared[KEY] ??= new Map<string, Lease>();
const callContext = shared[CONTEXT_KEY] ??= new AsyncLocalStorage<string>();

// Each guard has its own claim. A legacy guard consuming v1 cannot steal the
// ACP claim. Identity comes from AsyncLocalStorage, never a model-supplied ID.
shared[AUTHORITY_KEY] = {
  claim(consumer, sessionId, tool, args, eventId) {
    const key = callContext.getStore();
    const lease = key ? scopedLeases.get(key) : undefined;
    if (!lease || !consumer || !eventId || Date.now() > lease.expiresAt
      || lease.consumers.has(consumer) || (lease.eventId !== undefined && lease.eventId !== eventId)) return undefined;
    try {
      if (!lease.matches(sessionId, tool, args)) return undefined;
    } catch { return undefined; }
    lease.eventId = eventId;
    lease.consumers.add(consumer);
    return Object.freeze({ monitorId: lease.monitorId, ...(lease.requiresReadOnly ? { requiresReadOnly: true } : {}) });
  },
};

export function claimMonitorCall(consumer: string, sessionId: string, tool: string, args: unknown, eventId: string): MonitorIdentity | undefined {
  return shared[AUTHORITY_KEY]?.claim(consumer, sessionId, tool, args, eventId);
}

/** One scoped execution; each cooperating guard may independently claim it once. */
export function leaseMonitorCall(monitorId: string, sessionId: string, tool: string,
  args: unknown, signal: AbortSignal, requiresReadOnly = false) {
  const expected = canonicalJson(args);
  const callId = `${monitorId}:${randomUUID()}`;
  const matches = (session: string, name: string, input: unknown) => !signal.aborted && session === sessionId
    && name === tool && canonicalJson(input) === expected;
  leases.set(callId, { monitorId, matches });
  scopedLeases.set(callId, { monitorId, requiresReadOnly, matches, expiresAt: Date.now() + 60_000, consumers: new Set() });
  const release = () => {
    leases.delete(callId);
    scopedLeases.delete(callId);
    signal.removeEventListener("abort", release);
  };
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  return { callId, release, run: <T>(callback: () => T): T => callContext.run(callId, callback) };
}
