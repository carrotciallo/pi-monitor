import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { leaseMonitorCall } from "../src/authorization.ts";

const localRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
const require = createRequire(import.meta.url);
const { createJiti } = await import(pathToFileURL(require.resolve("jiti", { paths: [localRoot] })).href);
const alias = Object.fromEntries(["pi-ai", "pi-agent-core", "pi-coding-agent"].map(name =>
  [`@earendil-works/${name}`, fileURLToPath(import.meta.resolve(`@earendil-works/${name}`))]));
const guardPath = process.env.PI_MONITOR_GUARD_PATH;
const guardModule = guardPath ? await createJiti(import.meta.url, { alias }).import(guardPath) : undefined;
const guard = guardModule?.default;
const guardTest = (name, fn) => test(name, {
  skip: guardPath ? false : "Set PI_MONITOR_GUARD_PATH to run external guard integration tests",
}, fn);

async function harness(root, id) {
  const { AgentSession } = await import(pathToFileURL(join(root, "dist/core/agent-session.js")).href);
  const { ExtensionRunner } = await import(pathToFileURL(join(root, "dist/core/extensions/runner.js")).href);
  const handlers = new Map(), entries = [], parents = [];
  guard({ on(name, fn) { handlers.set(name, [fn]); }, registerTool() {},
    appendEntry(type, data) { entries.push({ type, data }); }, sendMessage() {} });
  handlers.get("tool_call").unshift(event => { parents.push(event.parentToolCallId); });
  const manager = { getSessionId: () => id, getBranch: () => [] };
  const runner = new ExtensionRunner([{ path: guardPath, handlers }], {}, process.cwd(), manager, {});
  const session = Object.create(AgentSession.prototype);
  const tool = { name: "read", label: "read", description: "Static test query",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async () => ({ content: [{ type: "text", text: "pending" }], details: {} }) };
  const assistant = { role: "assistant", content: [], timestamp: Date.now() };
  session.agent = { toolExecution: "parallel", state: { messages: [assistant], tools: [tool] } };
  session._extensionRunner = runner;
  session._getCallableTools = () => [tool];
  session._findLastAssistantMessage = () => assistant;
  session._limitsModel = () => undefined;
  session.settingsManager = { getImageAutoResize: () => false };
  session._emit = () => {};
  runner.executeToolFn = (caller, name, args, options) => session._executeNestedToolCall(caller, name, args, options);
  runner.getCallableToolsFn = () => [tool];
  const ctx = runner.createToolContext("original-monitor-start", new AbortController().signal);
  return { ctx, entries, parents };
}

const sdkRoots = [["installed SDK", localRoot]];
if (process.env.PI_MONITOR_SECOND_SDK_ROOT) {
  sdkRoots.push(["additional SDK", process.env.PI_MONITOR_SECOND_SDK_ROOT]);
}
for (const [label, root] of sdkRoots) {
  guardTest(`${label}: real nested SDK events claim six scoped leases without warnings`, async () => {
    const id = `sdk-${label}`, h = await harness(root, id);
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      for (let i = 0; i < 6; i++) {
        now += 2000;
        const lease = leaseMonitorCall("pi-monitor:sdk-test", id, "read", { path: "static" }, new AbortController().signal);
        try {
          const outcome = await lease.run(() => h.ctx.executeTool("read", { path: "static" }, { parentToolCallId: lease.callId }));
          assert.equal(outcome.isError, false);
          assert.equal(outcome.result.content.map(block => block.text).join(""), "pending");
          assert.ok(["original-monitor-start", lease.callId].includes(h.parents.at(-1)));
        } finally { lease.release(); }
      }
      const state = h.entries.filter(entry => entry.type === "recoverable-tool-guard-state").at(-1).data;
      assert.equal(state.monitors["pi-monitor:sdk-test"].attempts, 6);
      assert.notEqual(state.paused, true);
      assert.equal(h.entries.some(entry => entry.type === "recoverable-tool-guard-pause"), false);
    } finally { Date.now = originalNow; }
  });
}

guardTest("SDK without a monitor lease uses ordinary repeat protection", async () => {
  const h = await harness(localRoot, "legacy-negative-control");
  for (let i = 0; i < 3; i++) {
    const lease = leaseMonitorCall("pi-monitor:negative", "legacy-negative-control", "read", { path: "static" }, new AbortController().signal);
    try {
      const outcome = await h.ctx.executeTool("read", { path: "static" });
      assert.equal(outcome.isError, false);
      if (i === 2) assert.match(outcome.result.content.map(block => block.text).join(""), /Third identical business result/);
    } finally { lease.release(); }
  }
  const outcome = await h.ctx.executeTool("read", { path: "static" });
  assert.equal(outcome.isError, true);
  assert.match(outcome.result.content.map(block => block.text).join(""), /NO_BUSINESS_PROGRESS/);
  const state = h.entries.filter(entry => entry.type === "recoverable-tool-guard-state").at(-1).data;
  assert.deepEqual(state.monitors, {});
});
