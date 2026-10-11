import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedShellQuery } from "../src/shell-policy.ts";
import { isAllowedMonitorTool } from "../src/tools.ts";
import piMonitor from "../src/index.ts";

test("bash and hypa_shell accept arbitrary nonempty commands without command filtering", () => {
  // Validation only: these strings are never executed by this test.
  for (const command of ["ps aux", "ps | grep worker", "curl https://example.com", "python -c 'print(1)'", "echo $STATE", "printf done > output", "task-start && task-status", "echo one\necho two"]) {
    assert.equal(isAllowedShellQuery({ command }), true);
    for (const name of ["bash", "hypa_shell"]) {
      assert.equal(isAllowedMonitorTool(name, { destructiveHint: true }, { command }), true);
    }
  }
  for (const args of [{}, { command: "" }, { command: " \n " }, { command: 123 }]) {
    assert.equal(isAllowedShellQuery(args), false);
    assert.equal(isAllowedMonitorTool("bash", undefined, args), false);
  }
  assert.equal(isAllowedMonitorTool("write", { readOnlyHint: true }, { command: "echo done" }), false);
});

test("monitor_start executes shell queries through the existing host tool pipeline", async () => {
  const tools = new Map(), hooks = new Map(), messages = [];
  piMonitor({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {},
    on: (name, fn) => hooks.set(name, fn), sendMessage: msg => messages.push(msg),
    getAllTools: () => [{ name: "hypa_shell", annotations: { destructiveHint: true } }] });
  const command = "ps aux | grep worker";
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "shell-test" },
    async executeTool(name, args) {
      assert.equal(name, "hypa_shell");
      assert.equal(args.command, command);
      return { result: { content: [{ type: "text", text: "DONE" }] }, isError: false };
    } };
  try {
    const result = await tools.get("monitor_start").execute("start", {
      tool: "hypa_shell", args: { command }, condition: { textContains: "DONE" },
    }, undefined, undefined, ctx);
    assert.notEqual(result.isError, true);
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].details.status, "completed");
  } finally { hooks.get("session_shutdown")({}, ctx); }
});
