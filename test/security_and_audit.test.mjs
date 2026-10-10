import test from "node:test";
import assert from "node:assert/strict";
import {
  getNestedField,
  matchesTextMarker,
  deepEquals,
  computeSha256,
  validateCondition,
  matchesCondition,
} from "../src/matcher.ts";
import {
  isAllowedMonitorTool,
  sanitizeRecord,
  sanitizeValue,
  cleanControlCharacters,
} from "../src/tools.ts";
import { MonitorScheduler } from "../src/scheduler.ts";
import piMonitor from "../src/index.ts";

test("Audit Item 1: isAllowedMonitorTool strictly enforces Default-Deny and blocks gateway/mutating tools", () => {
  // Dangerous / generic gateway tools MUST be rejected
  assert.equal(isAllowedMonitorTool("mcp"), false);
  assert.equal(isAllowedMonitorTool("mcpScript"), false);
  assert.equal(isAllowedMonitorTool("mcp_server_tool"), false);
  assert.equal(isAllowedMonitorTool("mcpScript_run"), false);
  assert.equal(isAllowedMonitorTool("bambu-printer_print_3mf"), false);
  assert.equal(isAllowedMonitorTool("ast_grep_replace"), false);
  assert.equal(isAllowedMonitorTool("bash"), false);
  assert.equal(isAllowedMonitorTool("shell"), false);
  assert.equal(isAllowedMonitorTool("hypa_shell"), false);
  assert.equal(isAllowedMonitorTool("powershell"), false);
  assert.equal(isAllowedMonitorTool("write_file"), false);
  assert.equal(isAllowedMonitorTool("edit_file"), false);
  assert.equal(isAllowedMonitorTool("patch"), false);
  assert.equal(isAllowedMonitorTool("delete_node"), false);
  assert.equal(isAllowedMonitorTool("kill_process"), false);
  assert.equal(isAllowedMonitorTool("agent_wait_policy"), false);
  assert.equal(isAllowedMonitorTool("monitor_start"), false);

  // Even if mislabelled as readOnlyHint:
  assert.equal(isAllowedMonitorTool("bash", { readOnlyHint: true }), false);
  assert.equal(isAllowedMonitorTool("bambu-printer_print_3mf", { readOnlyHint: true }), false);
  assert.equal(isAllowedMonitorTool("ast_grep_replace", { readOnlyHint: true }), false);

  // Unknown tools without readOnlyHint must be rejected (Default-Deny)
  assert.equal(isAllowedMonitorTool("some_arbitrary_tool"), false);
  assert.equal(isAllowedMonitorTool("random_plugin"), false);

  // Known safe read-only tools must be allowed
  assert.equal(isAllowedMonitorTool("read"), true);
  assert.equal(isAllowedMonitorTool("grep"), true);
  assert.equal(isAllowedMonitorTool("find"), true);
  assert.equal(isAllowedMonitorTool("ls"), true);
  assert.equal(isAllowedMonitorTool("hypa_read"), true);
  assert.equal(isAllowedMonitorTool("hypa_grep"), true);
  assert.equal(isAllowedMonitorTool("hypa_find"), true);
  assert.equal(isAllowedMonitorTool("hypa_ls"), true);

  // Query-like tools with readOnlyHint must be allowed
  assert.equal(isAllowedMonitorTool("bambu-printer_get_printer_status", { readOnlyHint: true }), true);
  assert.equal(isAllowedMonitorTool("remote_query", { readOnlyHint: true }), true);
  assert.equal(isAllowedMonitorTool("job_status", { readOnlyHint: true }), true);
});

test("Audit Item 6: Matcher rejects implicit truthiness and requires exactly one operator", () => {
  // Reject missing operator
  assert.throws(() => validateCondition({ field: "status" }), /exactly one operator/);
  // Reject multiple operators
  assert.throws(() => validateCondition({ field: "status", equals: "ok", greaterThan: 5 }), /exactly one operator/);
  // Accept exactly one operator
  assert.doesNotThrow(() => validateCondition({ field: "status", equals: "ok" }));
  assert.doesNotThrow(() => validateCondition({ field: "count", greaterThan: 0 }));
  assert.doesNotThrow(() => validateCondition({ field: "tags", in: ["ready", "done"] }));

  // matchesCondition returns false on invalid conditions
  const res = { isError: false, content: '{"status":"ok"}' };
  assert.equal(matchesCondition({ field: "status" }, res).matched, false);
});

test("Audit Item 6: Matcher prototype pollution and prototype inheritance defense", () => {
  const payload = {
    nested: { title: "good" }
  };

  assert.equal(getNestedField(payload, "__proto__"), undefined);
  assert.equal(getNestedField(payload, "constructor"), undefined);
  assert.equal(getNestedField(payload, "prototype"), undefined);
  // Prototype inherited methods like toString must not be returned
  assert.equal(getNestedField(payload, "toString"), undefined);
  assert.equal(getNestedField(payload, "nested.title"), "good");
});

test("Audit Item 6: Matcher enhanced negation phrases and prefixes", () => {
  assert.equal(matchesTextMarker("job is not yet ready", "ready"), false);
  assert.equal(matchesTextMarker("system is not quite ready", "ready"), false);
  assert.equal(matchesTextMarker("server is not fully ready", "ready"), false);
  assert.equal(matchesTextMarker("task is incompleted", "completed"), false);
  assert.equal(matchesTextMarker("process is uncompleted", "completed"), false);
  assert.equal(matchesTextMarker("state: completed successfully", "completed"), true);
});

test("Audit Item 6: Matcher ReDoS prevention and regex length cap", () => {
  // Length > 200
  assert.throws(() => validateCondition({ textMatches: "a".repeat(201) }), /exceed 200/);
  // These patterns are safe with RE2JS's linear-time engine.
  assert.doesNotThrow(() => validateCondition({ textMatches: "(a+)+" }));
  assert.doesNotThrow(() => validateCondition({ textMatches: "(a*)*" }));
  assert.doesNotThrow(() => validateCondition({ textMatches: "([a-z]+)*" }));
  assert.equal(matchesCondition({ textMatches: "^(a|aa)+$" }, {
    isError: false, content: "a".repeat(60000) + "!",
  }).matched, false);
  assert.throws(() => validateCondition({ textMatches: "(a)\\1" }), /Invalid regex/);

  // Safe regex
  assert.doesNotThrow(() => validateCondition({ textMatches: "status:\\s*SUCCESS" }));
});

test("Audit Item 6: deepEquals circular reference and depth cap protection", () => {
  const circularA = { a: 1 };
  circularA.self = circularA;
  const circularB = { a: 1 };
  circularB.self = circularB;

  // Does not throw RangeError (Maximum call stack size exceeded)
  assert.doesNotThrow(() => deepEquals(circularA, circularB));

  // Deeply nested objects beyond depth 32
  let deepA = { v: 1 };
  let deepB = { v: 1 };
  for (let i = 0; i < 40; i++) {
    deepA = { next: deepA };
    deepB = { next: deepB };
  }
  assert.equal(deepEquals(deepA, deepB), false);
});

test("Audit Item 6: computeSha256 canonical property order", () => {
  const h1 = computeSha256({ z: 1, a: 2, m: { b: 3, a: 4 } });
  const h2 = computeSha256({ a: 2, z: 1, m: { a: 4, b: 3 } });
  assert.equal(h1, h2);
});

test("Audit Item 2: Scheduler hard deadline aborts and strictly discards late results", async () => {
  let finishExecution = null;
  const toolExecutor = async (_tool, _args, options) => {
    // Wait until resolved or aborted
    return new Promise((resolve) => {
      finishExecution = () => resolve({ content: "late result: done", structuredContent: { status: "done" }, isError: false });
      const signal = options instanceof AbortSignal ? options : options.signal;
      signal.addEventListener("abort", () => {
        // Still attempt to return after abort to simulate late delayed return
      });
    });
  };

  const sent = [];
  const mockApi = { sendMessage: (msg, opts) => sent.push({ msg, opts }) };
  const scheduler = new MonitorScheduler(toolExecutor, mockApi);

  const record = scheduler.startMonitor(
    "sess-dl",
    "slow_tool",
    {},
    { field: "status", equals: "done" },
    { intervalSeconds: 2, timeoutSeconds: 4 }
  );

  assert.equal(record.status, "running");

  // Wait 4.5s for hard deadline timer to trigger
  await new Promise(r => setTimeout(r, 4500));

  assert.equal(record.status, "timed_out");
  assert.ok(record.terminalReason.includes("Hard timeout"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.details.status, "timed_out");

  // Now simulate the tool resolving late
  if (finishExecution) finishExecution();
  await new Promise(r => setTimeout(r, 200));

  // Status must remain timed_out, NOT mutated to completed!
  assert.equal(record.status, "timed_out");
  assert.equal(sent.length, 1, "Must NOT send another notification on late result");

  scheduler.pruneSession("sess-dl");
});

test("Audit Item 4: Cross-session cancellation is strictly blocked", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const rec = scheduler.startMonitor("session-alpha", "read", {}, { textContains: "ok" });

  // Cancel from wrong session must return false
  const blocked = scheduler.cancel(rec.id, "Cancel attempt", "session-beta");
  assert.equal(blocked, false);
  assert.equal(rec.status, "running");

  // Cancel from matching session succeeds
  const allowed = scheduler.cancel(rec.id, "Valid cancel", "session-alpha");
  assert.equal(allowed, true);
  assert.equal(rec.status, "cancelled");

  scheduler.pruneSession("session-alpha");
});

test("Audit Item 7: Max stored records per session is bounded at 10", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  for (let i = 0; i < 15; i++) {
    const r = scheduler.startMonitor("sess-cap", "read", { idx: i }, { textContains: "x" });
    scheduler.cancel(r.id, "cancelled", "sess-cap");
  }

  const records = scheduler.getSessionRecords("sess-cap");
  assert.ok(records.length <= 10, `Stored records count (${records.length}) must be <= 10`);

  scheduler.pruneSession("sess-cap");
});

test("Audit Item 8: Sensitive parameter redaction, control char cleanup and content truncation", () => {
  const sensitiveRecord = {
    id: "mon_1",
    sessionId: "s1",
    generation: 1,
    tool: "remote_status",
    args: {
      url: "https://api.example.com",
      apiKey: "sk-supersecretkey12345",
      auth_token: "bearer-xyz",
      nested: { password: "mypassword" }
    },
    condition: { textContains: "done" },
    options: { intervalSeconds: 5, timeoutSeconds: 60, maxRetries: 3 },
    status: "completed",
    createdAt: Date.now(),
    startedAt: Date.now(),
    deadline: Date.now() + 60000,
    attempts: 1,
    consecutiveErrors: 0,
    lastResult: {
      isError: false,
      content: "\x1b[32mSUCCESS\x1b[0m\x00\x07" + "A".repeat(5000),
      structuredContent: { secret_token: "hidden" }
    },
    notified: true
  };

  const sanitized = sanitizeRecord(sensitiveRecord);
  assert.equal(sanitized.args.apiKey, "[REDACTED]");
  assert.equal(sanitized.args.auth_token, "[REDACTED]");
  assert.equal(sanitized.args.nested.password, "[REDACTED]");
  assert.equal(sanitized.lastResult.structuredContent.secret_token, "[REDACTED]");
  assert.ok(!sanitized.lastResult.content.includes("\x1b[32m"));
  assert.ok(!sanitized.lastResult.content.includes("\x00"));
  assert.ok(sanitized.lastResult.content.length <= 4150);
  assert.ok(sanitized.lastResult.content.includes("...[truncated]"));
});

test("Audit Item 3: executeTool propagates parentToolCallId for guard coexistence", async () => {
  let capturedOptions = null;
  const mockApi = {
    getAllTools: () => [{ name: "remote_status", annotations: { readOnlyHint: true } }],
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: () => () => {},
    sendMessage: () => {},
    appendEntry: () => {},
  };

  piMonitor(mockApi);

  const mockToolCtx = {
    sessionManager: { getSessionId: () => "sess-bridge" },
    executeTool: async (toolName, args, opts) => {
      capturedOptions = opts;
      return {
        toolCall: { id: "call-1", name: toolName, arguments: args },
        result: { content: [{ type: "text", text: "status: ok" }], structuredContent: { status: "ok" } },
        isError: false
      };
    }
  };

  const scheduler = new MonitorScheduler(async (tool, args, opts, ctx) => {
    return mockToolCtx.executeTool(tool, args, opts);
  });

  const record = scheduler.startMonitor("sess-bridge", "remote_status", {}, { field: "status", equals: "ok" }, { intervalSeconds: 2 }, mockToolCtx);

  await new Promise(r => setTimeout(r, 700));

  assert.ok(capturedOptions, "executeTool options must be passed");
  assert.equal(capturedOptions.parentToolCallId, "pi-monitor:" + record.id, "parentToolCallId must follow pi-monitor:<id> convention");

  scheduler.pruneSession("sess-bridge");
});
