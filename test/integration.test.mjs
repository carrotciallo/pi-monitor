import test from "node:test";
import assert from "node:assert/strict";
import piMonitor, { MONITOR_GUIDELINE } from "../src/index.ts";

function createMockEnvironment() {
  const registeredTools = new Map();
  const registeredCommands = new Map();
  const lifecycleListeners = new Map();
  const sentMessages = [];
  const widgets = new Map();
  const statuses = new Map();
  const notifications = [];

  const mockToolsList = [
    {
      name: "bambu-printer_get_printer_status",
      description: "Get Bambu 3D printer status",
      parameters: {},
      annotations: { readOnlyHint: true },
      execute: async () => ({
        content: [{ type: "text", text: JSON.stringify({ state: "PRINTING", nozzle_temp: 220, bed_temp: 60 }) }],
        structuredContent: { state: "PRINTING", nozzle_temp: 220, bed_temp: 60 },
        isError: false,
      }),
    },
    {
      name: "bash",
      description: "Run bash command",
      parameters: {},
      annotations: { destructiveHint: true },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    },
    {
      name: "hypa_shell",
      description: "Run shell",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    },
  ];

  const api = {
    getAllTools() {
      return mockToolsList;
    },
    registerTool(toolDef) {
      registeredTools.set(toolDef.name, toolDef);
    },
    registerCommand(name, opts) {
      registeredCommands.set(name, opts);
    },
    on(event, handler) {
      if (!lifecycleListeners.has(event)) lifecycleListeners.set(event, []);
      lifecycleListeners.get(event).push(handler);
      return () => {};
    },
    sendMessage(msg, opts) {
      sentMessages.push({ msg, opts });
    },
    appendEntry() {},
  };

  const createToolContext = (sessionId = "test-session") => ({
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      setWidget(key, lines) {
        if (lines === undefined) widgets.delete(key);
        else widgets.set(key, lines);
      },
      setStatus(key, text) {
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      notify(msg, type) {
        notifications.push({ msg, type });
      },
    },
    tools: mockToolsList,
    executeTool: async (name, args, opts) => {
      const tool = mockToolsList.find(t => t.name === name);
      if (!tool) throw new Error("Tool not found");
      const res = await tool.execute("call-1", args, opts?.signal);
      return { toolCall: { id: "call-1", name, arguments: args }, result: res, isError: res.isError };
    },
  });

  return {
    api,
    mockToolsList,
    registeredTools,
    registeredCommands,
    lifecycleListeners,
    sentMessages,
    widgets,
    statuses,
    notifications,
    createToolContext,
  };
}

test("piMonitor registers tools, commands and prompt guidelines", () => {
  const env = createMockEnvironment();
  piMonitor(env.api);

  assert.ok(env.registeredTools.has("monitor_start"));
  assert.ok(env.registeredTools.has("monitor_status"));
  assert.ok(env.registeredTools.has("monitor_cancel"));
  assert.ok(env.registeredCommands.has("monitor_cancel"));
  assert.ok(env.registeredCommands.has("monitor_status"));

  // Check guideline event
  const beforeStartHandlers = env.lifecycleListeners.get("before_agent_start");
  assert.ok(beforeStartHandlers && beforeStartHandlers.length > 0);
  const promptOptions = { promptGuidelines: [] };
  beforeStartHandlers[0]({ systemPromptOptions: promptOptions });
  assert.ok(promptOptions.promptGuidelines.includes(MONITOR_GUIDELINE));
});

test("monitor_start rejects dangerous/destructive tools", async () => {
  const env = createMockEnvironment();
  piMonitor(env.api);

  const startTool = env.registeredTools.get("monitor_start");
  const ctx = env.createToolContext("sec-session");

  // Rejects bash
  const resBash = await startTool.execute("call-1", {
    tool: "bash",
    condition: { textContains: "done" },
  }, undefined, undefined, ctx);
  assert.equal(resBash.isError, true);
  assert.ok(resBash.content[0].text.includes("cannot be used for background monitoring"));

  // Rejects hypa_shell
  const resShell = await startTool.execute("call-2", {
    tool: "hypa_shell",
    condition: { textContains: "done" },
  }, undefined, undefined, ctx);
  assert.equal(resShell.isError, true);
  assert.ok(resShell.content[0].text.includes("cannot be used for background monitoring"));

  // Rejects non-existent tool
  const resUnknown = await startTool.execute("call-3", {
    tool: "does_not_exist",
    condition: { textContains: "done" },
  }, undefined, undefined, ctx);
  assert.equal(resUnknown.isError, true);
  assert.ok(resUnknown.content[0].text.includes("not found"));
});

test("monitor_start starts background monitor, updates Pi-Web UI widgets, and sends completion notification", async () => {
  const env = createMockEnvironment();
  let statusCallCount = 0;

  // Make printer status transition to completed on 2nd query
  env.mockToolsList[0].execute = async () => {
    statusCallCount++;
    if (statusCallCount === 1) {
      return {
        content: [{ type: "text", text: JSON.stringify({ state: "HEATING", nozzle_temp: 180 }) }],
        structuredContent: { state: "HEATING", nozzle_temp: 180 },
        isError: false,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ state: "PRINTING", nozzle_temp: 220 }) }],
      structuredContent: { state: "PRINTING", nozzle_temp: 220 },
      isError: false,
    };
  };

  piMonitor(env.api);
  const startTool = env.registeredTools.get("monitor_start");
  const ctx = env.createToolContext("bambu-session");

  // Fire session_start lifecycle
  for (const handler of env.lifecycleListeners.get("session_start") ?? []) {
    handler({}, ctx);
  }

  // 1. Call monitor_start
  const startRes = await startTool.execute("call-mon-1", {
    tool: "bambu-printer_get_printer_status",
    condition: { field: "state", equals: "PRINTING" },
    intervalSeconds: 2,
    timeoutSeconds: 10,
    description: "Wait for task readiness",
  }, undefined, undefined, ctx);

  assert.equal(startRes.isError, undefined);
  const parsedResponse = JSON.parse(startRes.content[0].text);
  assert.equal(parsedResponse.started, true);
  assert.equal(parsedResponse.status, "running");
  const monitorId = parsedResponse.monitorId;
  assert.ok(monitorId);

  // 2. Check UI was updated immediately
  const widgetLines = env.widgets.get("pi-monitor");
  assert.ok(widgetLines && widgetLines.length > 0, "Widget lines should be present above editor");
  assert.ok(widgetLines[0].includes("Running"));
  assert.equal(widgetLines.length, 1);
  assert.equal(env.statuses.get(`command:/monitor_cancel ${monitorId}`), undefined,
    "Cancellation is agent-only, not a status shelf action");

  // 3. Wait for background polling to finish (initial check at 500ms, second check at 2.5s)
  await new Promise(r => setTimeout(r, 2800));

  // 4. Verify turn-waking notification was delivered
  assert.equal(env.sentMessages.length, 1);
  const notif = env.sentMessages[0];
  assert.equal(notif.opts.triggerTurn, true);
  assert.equal(notif.opts.deliverAs, "followUp");
  assert.equal(notif.msg.customType, "pi-monitor:notification");
  assert.ok(notif.msg.content.includes("Status: completed"));
  assert.ok(notif.msg.content.includes("Wait for task readiness"));
  assert.equal(notif.msg.details.lastResult, undefined);
  assert.equal(notif.msg.details.status, "completed");

  // 5. Verify cancel button on status shelf was cleaned up on completion
  assert.equal(env.statuses.get(`command:/monitor_cancel ${monitorId}`), undefined);

  // Fire session_shutdown
  for (const handler of env.lifecycleListeners.get("session_shutdown") ?? []) {
    handler({}, ctx);
  }
});

test("slash command /monitor_cancel cancels monitor", async () => {
  const env = createMockEnvironment();
  piMonitor(env.api);

  const startTool = env.registeredTools.get("monitor_start");
  const cancelCmd = env.registeredCommands.get("monitor_cancel");
  const ctx = env.createToolContext("cmd-session");

  // Start monitor
  const startRes = await startTool.execute("call-1", {
    tool: "bambu-printer_get_printer_status",
    condition: { field: "state", equals: "PRINTING" },
    intervalSeconds: 5,
  }, undefined, undefined, ctx);

  const monitorId = JSON.parse(startRes.content[0].text).monitorId;

  // Execute /monitor_cancel <id>
  await cancelCmd.handler(monitorId, ctx);

  assert.ok(env.notifications.some(n => n.msg.includes(`Cancelled monitor: ${monitorId}`)));
  assert.equal(env.statuses.get(`command:/monitor_cancel ${monitorId}`), undefined);
});
