import test from "node:test";
import assert from "node:assert/strict";
import { MonitorScheduler } from "./notification-host.mjs";
import piMonitor from "../src/index.ts";
import { MAX_STORED_RECORDS_PER_SESSION, STATE_ENTRY_TYPE } from "../src/types.ts";

function harness(t, executor = async () => ({ content: "done", isError: false })) {
  const messages = [], entries = [];
  const api = { sendMessage: (...args) => messages.push(args), appendEntry: (type, data) => entries.push({ type, data }) };
  const scheduler = new MonitorScheduler(executor, api);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "recovery" } };
  t.after(() => scheduler.pruneSession("recovery"));
  function start(args = {}, options = {}) {
    const record = scheduler.startMonitor("recovery", "read", args, { textContains: "done" }, options, ctx);
    clearTimeout(scheduler.timers.get(record.id));
    scheduler.timers.delete(record.id);
    return record;
  }
  return { scheduler, start, ctx, api, messages, entries };
}

test("record eviction bounds all auxiliary indexes; shutdown releases every entry", t => {
  const h = harness(t);
  for (let i = 0; i < 1000; i++) {
    const r = h.start({ i });
    h.scheduler.cancel(r.id);
  }
  assert.equal(h.scheduler.records.size, MAX_STORED_RECORDS_PER_SESSION);
  assert.ok(h.scheduler.persisted.get("recovery").size <= MAX_STORED_RECORDS_PER_SESSION);
  assert.equal(h.scheduler.inFlight.size, 0);
  assert.equal(h.scheduler.abortControllers.size, 0);
  assert.equal(h.scheduler.deadlineTimers.size, 0);
  h.scheduler.pruneSession("recovery");
  for (const name of ["records", "sessionMonitors", "persisted", "inFlight", "abortControllers", "timers", "deadlineTimers", "clearWidgetTimers", "lostNotified", "interruptionNotified", "toolContexts", "uiContexts"]) {
    assert.equal(h.scheduler[name].size, 0, name);
  }
});

test("late tool settlement cannot recreate indexes after pruning", async t => {
  let resolve;
  const h = harness(t, () => new Promise(r => { resolve = r; }));
  const r = h.start();
  const poll = h.scheduler.pollStep(r.id);
  assert.equal(h.scheduler.inFlight.size, 1);
  h.scheduler.pruneSession("recovery");
  resolve({ content: "done", isError: false });
  await poll;
  assert.equal(h.scheduler.inFlight.size, 0);
  assert.equal(h.scheduler.abortControllers.size, 0);
  assert.equal(h.scheduler.records.size, 0);
  assert.equal(h.messages.length, 0);
});

test("UI faults cannot halt polling or suppress terminal delivery", async t => {
  let content = "pending";
  const h = harness(t, async () => ({ content, isError: false }));
  const fail = () => { throw new Error("AUDIT_UI_FAILURE"); };
  Object.assign(h.ctx, { hasUI: true, ui: { setWidget: fail, setStatus: fail, notify: fail } });
  const r = h.start();
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "running");
  assert.ok(h.scheduler.timers.has(r.id));
  content = "done";
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "completed");
  assert.equal(r.notified, true);
  assert.equal(h.messages.length, 1);
});

test("unconfirmed delivery stays visible and is not blindly retried", async t => {
  const h = harness(t);
  let calls = 0;
  h.api.sendMessage = () => { calls++; throw new Error("AUDIT_SEND_FAILURE"); };
  const r = h.start();
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "completed");
  assert.equal(r.notified, false);
  assert.match(r.notificationError, /unconfirmed.*automatic retry suppressed/);
  assert.equal(h.scheduler.timers.has(r.id), false);
  await h.scheduler.pollStep(r.id);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(h.entries), /AUDIT_SEND_FAILURE/);
});

test("invalid samples fail within the retry budget without invoking getters", async t => {
  let reads = 0;
  const structuredContent = Object.defineProperty({}, "state", { enumerable: true, get() { reads++; throw new Error("AUDIT_GETTER_FAILURE"); } });
  const h = harness(t, async () => ({ content: "done", structuredContent, isError: false }));
  const r = h.start({}, { maxRetries: 1 });
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "running");
  assert.ok(h.scheduler.timers.has(r.id));
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "failed");
  assert.equal(reads, 0);
  assert.equal(h.messages.length, 1);
});

test("unexpected processing faults terminate rather than stranding a running monitor", async t => {
  const h = harness(t, async () => ({ content: 42, isError: true }));
  const r = h.start();
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "failed");
  assert.match(r.terminalReason, /Internal sample processing failed/);
  assert.equal(h.scheduler.timers.has(r.id), false);
  assert.equal(h.messages.length, 1);
});

test("reconciliation bounds historic descriptors and notification indexes", t => {
  const h = harness(t);
  const entries = Array.from({ length: 100 }, (_, i) => ({ type: "custom", customType: STATE_ENTRY_TYPE,
    data: { version: 2, monitorId: `old-${i}`, event: "started", status: "running", tool: "read", argsHash: "digest", options: {}, createdAt: i } }));
  const { lost } = h.scheduler.reconcilePersisted("recovery", entries);
  assert.equal(lost.length, MAX_STORED_RECORDS_PER_SESSION);
  h.scheduler.notifyLost("recovery", lost);
  assert.equal(h.scheduler.lostNotified.size, MAX_STORED_RECORDS_PER_SESSION);
  h.scheduler.reconcilePersisted("recovery", []);
  assert.equal(h.scheduler.lostNotified.size, 0);
});

test("committed tree navigation reconciles the destination branch", () => {
  const hooks = new Map(), messages = [];
  const api = { on: (name, fn) => hooks.set(name, fn), registerTool() {}, registerCommand() {},
    sendMessage: (msg, opts) => messages.push({ msg, opts }), appendEntry() {} };
  piMonitor(api);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "tree", getBranch: () => [{
    type: "custom", customType: STATE_ENTRY_TYPE,
    data: { version: 2, monitorId: "destination-lost", tool: "read", status: "running", event: "started", argsHash: "digest", options: {}, createdAt: 0 },
  }] } };
  hooks.get("session_tree")({}, ctx);
  assert.equal(messages.length, 1);
  assert.match(messages[0].msg.content, /destination-lost/);
  assert.equal(messages[0].opts.deliverAs, "nextTurn");
  assert.notEqual(messages[0].opts.triggerTurn, true);
  hooks.get("session_tree")({}, ctx);
  assert.equal(messages.length, 1);
  hooks.get("session_shutdown")({ reason: "quit" }, ctx);
});
