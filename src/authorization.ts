import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalJson } from "./matcher.ts";

const KEY = Symbol.for("pi-monitor.call-leases.v1");
interface Lease {
  monitorId: string;
  matches(sessionId: string, tool: string, args: unknown): boolean;
}
const CONTEXT_KEY = Symbol.for("pi-monitor.call-context.v1");
const shared = globalThis as typeof globalThis & {
  [KEY]?: Map<string, Lease>;
  [CONTEXT_KEY]?: AsyncLocalStorage<string>;
};
const leases = shared[KEY] ??= new Map<string, Lease>();
const callContext = shared[CONTEXT_KEY] ??= new AsyncLocalStorage<string>();

/** A one-use lease exists only while a scheduler query is executing. */
export function leaseMonitorCall(monitorId: string, sessionId: string, tool: string,
  args: unknown, signal: AbortSignal) {
  const expected = canonicalJson(args);
  const callId = `${monitorId}:${randomUUID()}`;
  leases.set(callId, {
    monitorId,
    matches: (session, name, input) => !signal.aborted && session === sessionId
      && name === tool && canonicalJson(input) === expected,
  });
  const release = () => {
    leases.delete(callId);
    signal.removeEventListener("abort", release);
  };
  signal.addEventListener("abort", release, { once: true });
  if (signal.aborted) release();
  return { callId, release, run: <T>(callback: () => T): T => callContext.run(callId, callback) };
}
