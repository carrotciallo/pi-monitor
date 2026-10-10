import test from "node:test";
import assert from "node:assert/strict";
import piMonitor from "../src/index.ts";
import { MonitorScheduler } from "../src/scheduler.ts";

test("ordinary hook contexts cannot overwrite the executable context", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const plain = { sessionManager: { getSessionId: () => "s" } };
  const executable = { ...plain, executeTool: async () => {} };
  scheduler.registerContext("s", executable);
  scheduler.registerToolContext("s", plain);
  scheduler.registerContext("s", plain);
  assert.equal(scheduler.toolContexts.get("s"), executable);
  assert.equal(scheduler.uiContexts.get("s"), plain);
  scheduler.pruneSession("s");
});

test("nested tool hooks with plain contexts do not break the second background query", async () => {
  const tools = new Map(), hooks = new Map(), messages = [];
  piMonitor({
    getAllTools: () => [{ name: "remote_status", annotations: { readOnlyHint: true } }],
    registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
    on: (name, fn) => hooks.set(name, fn),
    sendMessage: message => messages.push(message),
  });
  let queries = 0;
  const plain = { hasUI: false, sessionManager: { getSessionId: () => "context-regression" } };
  const executable = { ...plain, async executeTool(name, input) {
    hooks.get("tool_call")({ toolName: name, input }, plain);
    queries++;
    return { result: { content: [{ type: "text", text: queries === 1 ? "pending" : "done" }] }, isError: false };
  } };
  const response = await tools.get("monitor_start").execute("start", {
    tool: "remote_status", condition: { textContains: "done" }, intervalSeconds: 2, timeoutSeconds: 10,
  }, undefined, undefined, executable);
  try {
    await new Promise(resolve => setTimeout(resolve, 2800));
    const status = await tools.get("monitor_status").execute("status", {
      monitorId: response.details.recordId,
    }, undefined, undefined, executable);
    assert.equal(JSON.parse(status.content[0].text).status, "completed");
    assert.equal(queries, 2);
    assert.equal(messages.length, 1);
  } finally { hooks.get("session_shutdown")({}, plain); }
});
