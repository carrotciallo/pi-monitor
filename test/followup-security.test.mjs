import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { canonicalJson, computeSha256, deepEquals, matchesCondition } from "../src/matcher.ts";
import piMonitor from "../src/index.ts";
import { leaseMonitorCall } from "../src/authorization.ts";

const require = createRequire(import.meta.url);
const sdkPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = await import(pathToFileURL(require.resolve("jiti", { paths: [dirname(sdkPath)] })).href);
const alias = Object.fromEntries(["pi-ai", "pi-agent-core", "pi-coding-agent"].map(name => {
  const pkg = `@earendil-works/${name}`;
  return [pkg, fileURLToPath(import.meta.resolve(pkg))];
}));
const guardPath = process.env.PI_MONITOR_GUARD_PATH;
const guardModule = guardPath
  ? await createJiti(import.meta.url, { alias }).import(guardPath)
  : undefined;
const { claimMonitorCall, default: guardExtension } = guardModule ?? {};
const guardTest = (name, fn) => test(name, {
  skip: guardPath ? false : "Set PI_MONITOR_GUARD_PATH to run external guard integration tests",
}, fn);

test("shared references compare by JSON value and hashes ignore property order", () => {
  const x = { v: 1 }, y = { v: 1 };
  assert.equal(deepEquals({ a: x, b: x }, { a: y, b: y }), true);
  assert.equal(deepEquals(undefined, null), false);
  assert.equal(computeSha256({ b: x, a: x }), computeSha256({ a: y, b: y }));
});

test("cyclic, accessor and oversized structured inputs fail closed without invoking getters", () => {
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /Circular JSON/);
  let calls = 0;
  const accessor = { get status() { calls++; return "done"; } };
  for (const value of [cycle, accessor, { text: "x".repeat(300000) }, { value: 1n }]) {
    const result = matchesCondition({ field: "status", notEquals: "pending" }, {
      isError: false, content: "", structuredContent: value,
    });
    assert.equal(result.matched, false);
    assert.match(result.reason, /Invalid monitor input/);
  }
  assert.equal(calls, 0);
});

guardTest("monitor prefix alone grants no exemption; leases bind session, tool, args and allow one claim", () => {
  assert.equal(claimMonitorCall("pi-monitor:forged", "s", "read", {}), undefined);
  const controller = new AbortController();
  const lease = leaseMonitorCall("pi-monitor:real", "s", "read", { a: 1, b: 2 }, controller.signal);
  try {
    assert.equal(claimMonitorCall(lease.callId, "other", "read", { a: 1, b: 2 }), undefined);
    assert.equal(claimMonitorCall(lease.callId, "s", "write", { a: 1, b: 2 }), undefined);
    assert.equal(claimMonitorCall(lease.callId, "s", "read", { a: 9, b: 2 }), undefined);
    assert.equal(claimMonitorCall(lease.callId, "s", "read", { b: 2, a: 1 }), "pi-monitor:real");
    assert.equal(claimMonitorCall(lease.callId, "s", "read", { a: 1, b: 2 }), undefined);
  } finally { lease.release(); }
});

guardTest("async-scoped leases support legacy parent ids without authorizing concurrent callers", async () => {
  const lease = leaseMonitorCall("pi-monitor:legacy", "s", "read", { path: "x" }, new AbortController().signal);
  let enter, resume;
  const entered = new Promise(resolve => { enter = resolve; });
  const resumed = new Promise(resolve => { resume = resolve; });
  try {
    const active = lease.run(async () => {
      enter();
      await resumed;
      assert.equal(claimMonitorCall("original-start", "other", "read", { path: "x" }), undefined);
      assert.equal(claimMonitorCall("original-start", "s", "write", { path: "x" }), undefined);
      assert.equal(claimMonitorCall("original-start", "s", "read", { path: "y" }), undefined);
      assert.equal(claimMonitorCall("original-start", "s", "read", { path: "x" }), "pi-monitor:legacy");
      assert.equal(claimMonitorCall(undefined, "s", "read", { path: "x" }), undefined);
    });
    await entered;
    assert.equal(claimMonitorCall("original-start", "s", "read", { path: "x" }), undefined);
    resume();
    await active;
  } finally { resume(); lease.release(); }
});

guardTest("late async descendants cannot claim a released scope", async () => {
  const controller = new AbortController();
  const lease = leaseMonitorCall("pi-monitor:late", "s", "read", {}, controller.signal);
  await lease.run(async () => {
    controller.abort();
    await Promise.resolve();
    assert.equal(claimMonitorCall(undefined, "s", "read", {}), undefined);
  });
  lease.release();
});

guardTest("cancelled and released leases cannot grant exemptions", () => {
  const controller = new AbortController();
  const aborted = leaseMonitorCall("pi-monitor:a", "s", "read", {}, controller.signal);
  controller.abort();
  assert.equal(claimMonitorCall(aborted.callId, "s", "read", {}), undefined);
  const released = leaseMonitorCall("pi-monitor:b", "s", "read", {}, new AbortController().signal);
  released.release();
  assert.equal(claimMonitorCall(released.callId, "s", "read", {}), undefined);
});

guardTest("real extension bridge creates a consumable lease and guard records a stable monitor budget", async () => {
  const guardEvents = new Map(), monitorEvents = new Map(), tools = new Map(), entries = [];
  const base = { registerTool() {}, appendEntry(type, data) { entries.push({ type, data }); }, sendMessage() {} };
  guardExtension({ ...base, on(name, fn) { guardEvents.set(name, fn); } });
  piMonitor({ ...base, on(name, fn) { monitorEvents.set(name, fn); },
    registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools: () => [{ name: "remote_status", annotations: { readOnlyHint: true } }],
  });
  let capturedParent;
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "bridge-session", getBranch: () => [] },
    async executeTool(toolName, input, options) {
      capturedParent = options.parentToolCallId;
      const event = { toolName, input, toolCallId: "nested-1", parentToolCallId: capturedParent };
      assert.equal(guardEvents.get("tool_call")(event, ctx), undefined);
      assert.equal(claimMonitorCall(capturedParent, "bridge-session", toolName, input), undefined);
      const result = { content: [{ type: "text", text: "done" }], structuredContent: { status: "done" } };
      guardEvents.get("tool_result")({ ...event, ...result, isError: false }, ctx);
      return { result, isError: false };
    },
  };
  const result = await tools.get("monitor_start").execute("start", {
    tool: "remote_status", args: {}, condition: { field: "status", equals: "done" },
  }, undefined, undefined, ctx);
  const id = result.details.recordId;
  try {
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.ok(capturedParent?.startsWith(`pi-monitor:${id}:`));
    const state = entries.filter(entry => entry.type === "recoverable-tool-guard-state").at(-1).data;
    assert.equal(state.monitors[`pi-monitor:${id}`].attempts, 1);
    assert.equal(state.streak, undefined);
  } finally { monitorEvents.get("session_shutdown")({}, ctx); }
});
