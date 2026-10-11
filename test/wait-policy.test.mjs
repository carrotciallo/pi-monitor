import test from "node:test";
import assert from "node:assert/strict";
import piMonitor from "../src/index.ts";

test("monitor disables wait policy on load and each turn, and blocks stale calls", () => {
  const hooks = new Map();
  let active = ["read", "agent_wait_policy", "monitor_start"];
  piMonitor({ registerTool() {}, registerCommand() {}, on(name, fn) { hooks.set(name, fn); },
    getActiveTools: () => active, setActiveTools: names => { active = names; } });
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "demo" } };
  hooks.get("session_start")({}, ctx);
  assert.deepEqual(active, ["read", "monitor_start"]);
  active.push("agent_wait_policy");
  hooks.get("before_agent_start")({ systemPromptOptions: { promptGuidelines: [] } });
  assert.deepEqual(active, ["read", "monitor_start"]);
  const blocked = hooks.get("tool_call")({ toolName: "agent_wait_policy" }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /monitor_start/);
  assert.equal(hooks.get("tool_call")({ toolName: "read" }, ctx), undefined);
  hooks.get("session_shutdown")({}, ctx);
});
