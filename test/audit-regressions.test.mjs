import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import piMonitor from "../src/index.ts";
import { MonitorScheduler } from "../src/scheduler.ts";
import { computeSha256 } from "../src/matcher.ts";
import { sanitizeValue } from "../src/privacy.ts";
import { MAX_SAMPLE_LENGTH } from "../src/types.ts";
import { isAllowedMonitorTool } from "../src/tools.ts";
import { globToRegExp } from "../src/tool-trust.ts";

for (const tool of ["bash", "hypa_shell"]) {
  test(`${tool} respects explicit Deny while preserving the documented shell exception`, () => {
    for (const deny of [[tool], ["*"]]) {
      assert.equal(isAllowedMonitorTool(tool, undefined, { command: "date" }, { allow: [globToRegExp(tool)], deny: deny.map(globToRegExp) }), false);
    }
    assert.equal(isAllowedMonitorTool(tool, { destructiveHint: true }, { command: "date" }), true);
    assert.equal(isAllowedMonitorTool(tool, undefined, { command: "date" }), true);
  });
}

function harness(t, result) {
  const entries = [], messages = [];
  const api = { appendEntry: (type, data) => entries.push({ type, data }),
    sendMessage: (...args) => messages.push(args) };
  const scheduler = new MonitorScheduler(async () => result, api);
  const ctx = { hasUI: false, sessionManager: { getSessionId: () => "audit" } };
  t.after(() => scheduler.pruneSession("audit"));
  const start = (condition, args = {}, options = {}) => {
    const record = scheduler.startMonitor("audit", "read", args, condition, options, ctx);
    clearTimeout(scheduler.timers.get(record.id));
    scheduler.timers.delete(record.id);
    return record;
  };
  return { scheduler, start, entries, messages, api, ctx };
}

test("persistence v2 contains a digest and no raw arguments, condition, description or error", async t => {
  const secret = "AUDIT_SENTINEL_NOT_A_SECRET";
  const h = harness(t, { content: "", isError: true, errorText: secret });
  const r = h.start({ textContains: secret }, { accessToken: secret }, { description: secret, maxRetries: 0 });
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "failed");
  assert.equal(h.entries[0].data.version, 2);
  assert.equal(h.entries[0].data.argsHash, computeSha256({ accessToken: secret }));
  assert.equal(h.entries[0].data.condition, undefined);
  assert.ok(!JSON.stringify(h.entries).includes(secret));
  const fresh = new MonitorScheduler(async () => ({ content: "", isError: false }));
  assert.equal(fresh.reconcilePersisted("audit", [{ type: "custom", customType: h.entries[0].type,
    data: h.entries[0].data }]).lost.length, 1);
  fresh.pruneSession("audit");
});

test("sanitization covers camelCase, nested arrays, cycles, getters and output budgets", () => {
  let accessed = false;
  const input = { accessToken: "secret", nested: [{ clientSecret: "secret" }], credentials: "secret" };
  input.cycle = input;
  Object.defineProperty(input, "getter", { enumerable: true, get() { accessed = true; throw Error("getter"); } });
  const output = sanitizeValue("args", input);
  assert.equal(output.accessToken, "[REDACTED]");
  assert.equal(output.nested[0].clientSecret, "[REDACTED]");
  assert.equal(output.credentials, "[REDACTED]");
  assert.equal(output.cycle, "[CIRCULAR]");
  assert.equal(output.getter, "[ACCESSOR]");
  assert.equal(accessed, false);
  assert.ok(JSON.stringify(sanitizeValue("data", { text: "x".repeat(100000) })).length < 4200);
});

for (const kind of ["json", "text", "regex", "hash"]) {
  test(`full ${kind} samples match beyond the retention limit`, async t => {
    const content = kind === "json" ? JSON.stringify({ state: "done", padding: "x".repeat(5000) })
      : "x".repeat(70000) + " ready";
    const condition = kind === "json" ? { field: "state", equals: "done" }
      : kind === "text" ? { textContains: "ready" }
      : kind === "regex" ? { textMatches: "ready$" } : { resultSha256: computeSha256(content) };
    const h = harness(t, { content, isError: false });
    const r = h.start(condition);
    await h.scheduler.pollStep(r.id);
    assert.equal(r.status, "completed");
    assert.ok(r.lastResult.content.length <= 4096);
  });
}

test("over-budget samples fail visibly rather than silently missing", async t => {
  const h = harness(t, { content: "x".repeat(MAX_SAMPLE_LENGTH + 1), isError: false });
  const r = h.start({ textContains: "x" }, {}, { maxRetries: 0 });
  await h.scheduler.pollStep(r.id);
  assert.equal(r.status, "failed");
  assert.match(r.lastErrorText, /budget/);
});

test("notifications use the real host's default TUI component", async () => {
  let registrations = 0;
  piMonitor({ getAllTools: () => [], registerTool() {}, registerCommand() {}, on() {},
    registerMessageRenderer() { registrations++; } });
  assert.equal(registrations, 0);
  const root = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  const { CustomMessageComponent } = await import(pathToFileURL(join(root, "dist/modes/interactive/components/custom-message.js")).href);
  const { initTheme } = await import(pathToFileURL(join(root, "dist/modes/interactive/theme/theme.js")).href);
  initTheme();
  const component = new CustomMessageComponent({ role: "custom", customType: "pi-monitor:notification",
    content: "Monitor completed", display: true, timestamp: Date.now() });
  assert.ok(component.render(80).length > 0);
  component.invalidate();
  assert.ok(component.render(40).length > 0);
});
