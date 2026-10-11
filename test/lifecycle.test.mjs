import test from "node:test";
import assert from "node:assert/strict";
import piMonitor from "../src/index.ts";
import { MonitorScheduler } from "../src/scheduler.ts";
import { classifyShutdownReason, formatLostMonitorNotice, isSilentTerminal } from "../src/lifecycle.ts";
import { formatInterruptionNotice } from "../src/formatter.ts";
import { STATE_ENTRY_TYPE } from "../src/types.ts";

function createEnv() {
  const tools = new Map();
  const hooks = new Map();
  const messages = [];
  const entries = [];
  const api = {
    getAllTools: () => [{ name: "remote_status", annotations: { readOnlyHint: true } }],
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand() {},
    on(name, fn) { hooks.set(name, fn); return () => {}; },
    sendMessage(msg, opts) { messages.push({ msg, opts }); },
    appendEntry(type, data) { entries.push({ type, data }); },
  };
  return { tools, hooks, messages, entries, api };
}

test("interruption is distinct from explicit cancellation and never wakes a turn", async () => {
  const env = createEnv();
  piMonitor(env.api);
  const start = env.tools.get("monitor_start");

  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "life", getBranch: () => [] },
    ui: { setWidget() {}, setStatus() {}, notify() {} },
    async executeTool() { return { result: { content: [{ type: "text", text: "pending" }] }, isError: false }; },
  };

  const res = await start.execute("call-1", {
    tool: "remote_status", condition: { textContains: "never" }, intervalSeconds: 5, timeoutSeconds: 120,
  }, undefined, undefined, ctx);
  const monitorId = res.details.recordId;
  assert.ok(monitorId);

  // A branch switch interrupts rather than explicitly cancelling.
  env.hooks.get("session_before_tree")({ type: "session_before_tree" }, ctx);

  const schedulerRecord = env.entries.find(e => e.type === STATE_ENTRY_TYPE && e.data.event === "interrupted");
  assert.ok(schedulerRecord, "an interrupted terminal descriptor is persisted");
  assert.equal(schedulerRecord.data.status, "interrupted");
  assert.match(schedulerRecord.data.reason, /branch switch/);
  assert.match(schedulerRecord.data.interruptedBy, /branch switch/);

  await new Promise(r => setTimeout(r, 200));
  assert.equal(env.messages.length, 0, "interruption must not send a followUp / wake a turn");

  env.hooks.get("session_shutdown")({ reason: "quit" }, ctx);
});

test("session shutdown reason is classified in the interruption label", () => {
  assert.match(classifyShutdownReason("quit"), /interrupted: Pi quit/);
  assert.match(classifyShutdownReason("reload"), /interrupted: extension reload/);
  assert.match(classifyShutdownReason("resume"), /interrupted: session switched/);
  assert.match(classifyShutdownReason("fork"), /interrupted: session forked/);
  assert.equal(classifyShutdownReason("mystery"), "interrupted: session shutdown (mystery)");
});

test("running descriptors persist at start and lost monitors are reported on reconcile", () => {
  const api = { sendMessage() {}, appendEntry() {}, getAllTools: () => [], on: () => () => {}, registerTool() {}, registerCommand() {} };
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }), api);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "lost" } };

  const { record } = scheduler.startOrReuseMonitor("lost", "read", { path: "/tmp/x" }, { textContains: "x" }, {}, ctx);

  // Simulate a reload: a fresh scheduler reads the active branch custom entries.
  const empty = scheduler.reconcilePersisted("lost", []);
  assert.equal(empty.lost.length, 0);
  assert.equal(empty.interrupted.length, 0);

  const entries = [{
    type: "custom",
    customType: STATE_ENTRY_TYPE,
    data: {
      version: 1, monitorId: record.id, event: "started", tool: record.tool,
      argsHash: '{"path":"/tmp/x"}', condition: record.condition, options: record.options,
      status: "running", createdAt: record.createdAt, attempts: 3,
    },
  }];
  const fresh = new MonitorScheduler(async () => ({ content: "", isError: false }), api);
  const { lost } = fresh.reconcilePersisted("lost", entries);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].monitorId, record.id);

  const notice = formatLostMonitorNotice(lost);
  assert.match(notice, /no longer active/);
  assert.match(notice, /In-memory monitor state is not durable/);
  assert.match(notice, /read/);
  // The notice never leaks raw arguments or results.
  assert.doesNotMatch(notice, /\/tmp\/x/);

  // Reporting is once per runtime and not duplicated.
  assert.ok(fresh.notifyLost("lost", lost));
  assert.equal(fresh.notifyLost("lost", lost), undefined);

  scheduler.pruneSession("lost");
  fresh.pruneSession("lost");
});

test("terminal persisted descriptors are not reported as lost", () => {
  const api = { sendMessage() {}, appendEntry() {}, getAllTools: () => [], on: () => () => {}, registerTool() {}, registerCommand() {} };
  const fresh = new MonitorScheduler(async () => ({ content: "", isError: false }), api);
  const entries = [
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { version: 1, monitorId: "m1", event: "started", tool: "read", argsHash: "{}", condition: { textContains: "x" }, options: {}, status: "running", createdAt: 1 } },
    { type: "custom", customType: STATE_ENTRY_TYPE, data: { version: 1, monitorId: "m1", event: "completed", tool: "read", argsHash: "{}", condition: { textContains: "x" }, options: {}, status: "completed", createdAt: 1, terminalAt: 2 } },
  ];
  const { lost } = fresh.reconcilePersisted("done", entries);
  assert.equal(lost.length, 0);
  fresh.pruneSession("done");
});

test("interrupted records produce a UI resume notice without a turn-waking message", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const notifications = [];
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "notice", getBranch: () => [] },
    ui: { setWidget() {}, setStatus() {}, notify: (msg, type) => notifications.push({ msg, type }) },
  };
  scheduler.startMonitor("notice", "read", {}, { textContains: "x" }, { intervalSeconds: 5, description: "wait for X" }, ctx);
  scheduler.interruptSession("notice", "interrupted by branch switch");
  scheduler.notifyInterruptions("notice");

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].msg, /interrupted by a session\/branch change/);
  assert.match(notifications[0].msg, /wait for X/);
  assert.equal(notifications[0].type, "warning");

  // Notifying twice does not repeat the same interruption.
  scheduler.notifyInterruptions("notice");
  assert.equal(notifications.length, 1);

  scheduler.pruneSession("notice");
});

test("cancelled and interrupted terminal statuses are silent", () => {
  assert.equal(isSilentTerminal("cancelled"), true);
  assert.equal(isSilentTerminal("interrupted"), true);
  assert.equal(isSilentTerminal("completed"), false);
  assert.equal(isSilentTerminal("failed"), false);
  assert.equal(isSilentTerminal("timed_out"), false);

  const records = [{ id: "m1", options: { description: "one" } }, { id: "m2", options: {} }];
  const notice = formatInterruptionNotice(records);
  assert.match(notice, /m1 \(one\), m2/);
  assert.match(notice, /restart if still needed/);
});

test("persisted interrupted descriptors surface a resume notice after reload", () => {
  const api = { sendMessage() {}, appendEntry() {}, getAllTools: () => [], on: () => () => {}, registerTool() {}, registerCommand() {} };
  const fresh = new MonitorScheduler(async () => ({ content: "", isError: false }), api);
  const notifications = [];
  const ctx = {
    hasUI: true,
    sessionManager: {
      getSessionId: () => "pi",
      getBranch: () => [{
        type: "custom",
        customType: STATE_ENTRY_TYPE,
        data: {
          version: 1, monitorId: "mon_lost1", event: "interrupted", tool: "read",
          argsHash: "{}", condition: { textContains: "x" },
          options: { description: "wait for build" }, status: "interrupted",
          createdAt: 1, terminalAt: 2, interruptedBy: "interrupted by branch switch",
        },
      }],
    },
    ui: { setWidget() {}, setStatus() {}, notify: (msg, type) => notifications.push({ msg, type }) },
  };

  const { lost, interrupted } = fresh.reconcilePersisted("pi", ctx.sessionManager.getBranch());
  assert.equal(lost.length, 0);
  assert.equal(interrupted.length, 1, "a reloaded interruption is recovered from persistence");

  fresh.registerUIContext("pi", ctx);
  const notice = fresh.notifyInterruptions("pi");
  assert.match(notice, /interrupted by a session\/branch change/);
  assert.match(notice, /mon_lost1/);
  assert.match(notice, /wait for build/);
  assert.equal(notifications.length, 1);

  // A live in-memory record with the same id suppresses the persisted notice.
  fresh.pruneSession("pi");
});

test("a live running record hides its persisted descriptor from the lost list", () => {
  const api = { sendMessage() {}, appendEntry() {}, getAllTools: () => [], on: () => () => {}, registerTool() {}, registerCommand() {} };
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }), api);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "live" } };
  const { record } = scheduler.startOrReuseMonitor("live", "read", {}, { textContains: "x" }, { intervalSeconds: 5 }, ctx);

  const { lost } = scheduler.reconcilePersisted("live", [{
    type: "custom",
    customType: STATE_ENTRY_TYPE,
    data: { version: 1, monitorId: record.id, event: "started", tool: "read", argsHash: "{}", condition: { textContains: "x" }, options: {}, status: "running", createdAt: 1 },
  }]);
  assert.equal(lost.length, 0, "a live running monitor is not reported as lost");

  scheduler.pruneSession("live");
});

test("index session_start headless delivers exactly one nextTurn notice for a persisted interruption", () => {
  const entries = [{
    type: "custom",
    customType: STATE_ENTRY_TYPE,
    data: {
      version: 1, monitorId: "mon_reload1", event: "interrupted", tool: "read",
      argsHash: "{}", condition: { textContains: "x" },
      options: { description: "wait after reload" }, status: "interrupted",
      createdAt: 1, terminalAt: 2, interruptedBy: "interrupted: extension reload",
    },
  }];
  const messages = [];
  const hooks = new Map();
  const api = {
    getAllTools: () => [],
    registerTool() {},
    registerCommand() {},
    on(name, fn) { hooks.set(name, fn); return () => {}; },
    appendEntry() {},
    sendMessage(msg, opts) { messages.push({ msg, opts }); },
  };
  piMonitor(api);

  const ctx = {
    hasUI: false,
    sessionManager: { getSessionId: () => "headless", getBranch: () => entries },
    ui: { setWidget() {}, setStatus() {}, notify() {} },
  };

  hooks.get("session_start")({}, ctx);

  assert.equal(messages.length, 1, "exactly one lifecycle notice is delivered");
  assert.equal(messages[0].opts.deliverAs, "nextTurn");
  assert.notEqual(messages[0].opts.triggerTurn, true, "lifecycle notice must not trigger a turn");
  assert.notEqual(messages[0].opts.deliverAs, "followUp", "lifecycle notice must not wake a turn");
  assert.equal(messages[0].msg.customType, "pi-monitor:notification");
  assert.match(messages[0].msg.content, /interrupted by a session\/branch change/);
  assert.match(messages[0].msg.content, /mon_reload1/);

  // Re-running session_start must not duplicate the same interruption notice.
  hooks.get("session_start")({}, ctx);
  assert.equal(messages.length, 1);

  hooks.get("session_shutdown")({ reason: "quit" }, ctx);
});

test("index branch switch stops the monitor and a headless post-tree notice does not wake a turn", async () => {
  const messages = [];
  const entries = [];
  const hooks = new Map();
  const tools = new Map();
  const api = {
    getAllTools: () => [{ name: "remote_status", annotations: { readOnlyHint: true } }],
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(name, fn) { hooks.set(name, fn); return () => {}; },
    appendEntry(type, data) { entries.push({ type, data }); },
    sendMessage(msg, opts) { messages.push({ msg, opts }); },
  };
  piMonitor(api);

  const ctx = {
    hasUI: false,
    sessionManager: { getSessionId: () => "branch", getBranch: () => [] },
    ui: { setWidget() {}, setStatus() {}, notify() {} },
    async executeTool() { return { result: { content: [{ type: "text", text: "pending" }] }, isError: false }; },
  };

  // A real monitor is running in this runtime (not from persistence).
  const res = await tools.get("monitor_start").execute("call-1", {
    tool: "remote_status", condition: { textContains: "never" }, intervalSeconds: 30, timeoutSeconds: 3600,
  }, undefined, undefined, ctx);
  const monitorId = res.details.recordId;
  assert.ok(monitorId);
  messages.length = 0;

  // Branch switch: interrupt before the leaf moves, then post-tree notice.
  hooks.get("session_before_tree")({ type: "session_before_tree" }, ctx);
  assert.equal(entries.some(e => e.type === STATE_ENTRY_TYPE && e.data.event === "interrupted" && e.data.monitorId === monitorId), true);

  hooks.get("session_tree")({ type: "session_tree", newLeafId: "n", oldLeafId: "o" }, ctx);

  assert.equal(messages.length, 1, "the post-tree notice is delivered once");
  assert.equal(messages[0].opts.deliverAs, "nextTurn");
  assert.notEqual(messages[0].opts.triggerTurn, true);
  assert.match(messages[0].msg.content, /interrupted by a session\/branch change/);

  // The interrupted monitor never woke a turn or sent a followUp.
  assert.equal(messages.some(m => m.opts.deliverAs === "followUp" || m.opts.triggerTurn === true), false);

  hooks.get("session_shutdown")({ reason: "quit" }, ctx);
});
