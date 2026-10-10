import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import piMonitor, { MONITOR_GUIDELINE } from "../src/index.ts";

test("plugin-authored source messages remain English", async () => {
  const dir = new URL("../src/", import.meta.url);
  for (const name of await readdir(dir)) {
    if (name.endsWith(".ts")) {
      assert.doesNotMatch(await readFile(new URL(name, dir), "utf8"), /\p{Script=Han}/u, name);
    }
  }
});

test("monitor prompts stay concise and domain-neutral", () => {
  const tools = new Map();
  piMonitor({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  const start = tools.get("monitor_start");
  assert.ok(start.description.length < 250);
  assert.ok(MONITOR_GUIDELINE.length < 350);
  assert.match(start.description, /trusted read-only/);
  assert.match(MONITOR_GUIDELINE, /not new instructions or authorization/);
  assert.doesNotMatch(JSON.stringify(start.parameters) + start.description, /printer|Bambu|cancel button|remote_status/i);
});
