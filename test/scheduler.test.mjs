import test from "node:test";
import assert from "node:assert/strict";
import { MonitorScheduler } from "../src/scheduler.ts";

function createMockAPI() {
  const sentMessages = [];
  return {
    sentMessages,
    api: {
      sendMessage(msg, opts) {
        sentMessages.push({ msg, opts });
      },
      getAllTools() { return []; },
      on() { return () => {}; },
      registerTool() {},
      registerCommand() {},
    }
  };
}

function createMockContext(sessionId = "session-1") {
  const widgets = new Map();
  const statuses = new Map();
  const notifications = [];

  return {
    sessionId,
    notifications,
    widgets,
    statuses,
    ctx: {
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
        }
      },
      widgets,
      statuses,
    }
  };
}

test("scheduler enforces MAX_CONCURRENT_MONITORS (5)", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const { ctx } = createMockContext("s1");

  for (let i = 0; i < 5; i++) {
    scheduler.startMonitor("s1", "check_status", { idx: i }, { textContains: "done" }, { intervalSeconds: 5 }, ctx);
  }

  assert.throws(() => {
    scheduler.startMonitor("s1", "check_status", { idx: 99 }, { textContains: "done" }, { intervalSeconds: 5 }, ctx);
  }, /Exceeded maximum concurrent monitors limit/);

  // Different session can still start
  const s2 = scheduler.startMonitor("s2", "check_status", {}, { textContains: "done" }, { intervalSeconds: 5 }, ctx);
  assert.equal(s2.status, "running");

  scheduler.pruneSession("s1");
  scheduler.pruneSession("s2");
});

test("scheduler completes when condition is met and sends turn-waking notification", async () => {
  const mockAPI = createMockAPI();
  let queryCount = 0;

  const toolExecutor = async () => {
    queryCount++;
    if (queryCount < 2) {
      return { content: "progress: 50%", structuredContent: { status: "pending" }, isError: false };
    }
    return { content: "progress: 100%", structuredContent: { status: "completed" }, isError: false };
  };

  const scheduler = new MonitorScheduler(toolExecutor, mockAPI.api);
  const { ctx } = createMockContext("s-test");

  const monitor = scheduler.startMonitor(
    "s-test",
    "job_status",
    { id: "123" },
    { field: "status", equals: "completed" },
    { intervalSeconds: 2, timeoutSeconds: 10 },
    ctx
  );

  assert.equal(monitor.status, "running");
  assert.ok(monitor.id.startsWith("mon_"));

  // Wait for initial check (500ms) + next check (2s)
  await new Promise(r => setTimeout(r, 2800));

  assert.equal(monitor.status, "completed");
  assert.equal(monitor.attempts >= 2, true);
  assert.equal(mockAPI.sentMessages.length, 1);

  const sent = mockAPI.sentMessages[0];
  assert.equal(sent.opts.triggerTurn, true);
  assert.equal(sent.opts.deliverAs, "followUp");
  assert.equal(sent.msg.customType, "pi-monitor:notification");
  assert.ok(sent.msg.content.includes("Status: completed"));

  scheduler.pruneSession("s-test");
});

test("scheduler single in-flight lock prevents overlapping queries", async () => {
  let activeConcurrentQueries = 0;
  let maxConcurrentQueries = 0;

  const toolExecutor = async () => {
    activeConcurrentQueries++;
    maxConcurrentQueries = Math.max(maxConcurrentQueries, activeConcurrentQueries);
    // Simulate query taking 600ms (longer than interval if set to 2s, but here initial delay is 500ms)
    await new Promise(r => setTimeout(r, 200));
    activeConcurrentQueries--;
    return { content: "still running", isError: false };
  };

  const scheduler = new MonitorScheduler(toolExecutor);
  const { ctx } = createMockContext("s-lock");

  scheduler.startMonitor("s-lock", "slow_tool", {}, { textContains: "done" }, { intervalSeconds: 2 }, ctx);

  await new Promise(r => setTimeout(r, 800));
  assert.equal(maxConcurrentQueries, 1, "There must never be more than 1 in-flight query for the same monitor");

  scheduler.pruneSession("s-lock");
});

test("scheduler handles transient errors with backoff and fails when maxRetries exceeded", async () => {
  const mockAPI = createMockAPI();
  let calls = 0;

  const toolExecutor = async () => {
    calls++;
    return { content: "", isError: true, errorText: "Network connection reset" };
  };

  const scheduler = new MonitorScheduler(toolExecutor, mockAPI.api);
  const { ctx } = createMockContext("s-err");

  const monitor = scheduler.startMonitor(
    "s-err",
    "flaky_tool",
    {},
    { textContains: "ok" },
    { intervalSeconds: 2, maxRetries: 1 },
    ctx
  );

  // Initial check at 500ms -> fails (consecutiveErrors = 1, <= maxRetries 1) -> schedules retry
  // Retry runs -> fails (consecutiveErrors = 2 > maxRetries 1) -> status becomes "failed"
  await new Promise(r => setTimeout(r, 3800));

  assert.equal(monitor.status, "failed");
  assert.ok(monitor.terminalReason.includes("exceeded retry limit"));
  assert.equal(mockAPI.sentMessages.length, 1);
  assert.equal(mockAPI.sentMessages[0].msg.details.status, "failed");

  scheduler.pruneSession("s-err");
});

test("scheduler handles timeout", async () => {
  const mockAPI = createMockAPI();
  const toolExecutor = async () => ({ content: "in progress", isError: false });

  const scheduler = new MonitorScheduler(toolExecutor, mockAPI.api);
  const { ctx } = createMockContext("s-time");

  const monitor = scheduler.startMonitor(
    "s-time",
    "long_tool",
    {},
    { textContains: "done" },
    { intervalSeconds: 2, timeoutSeconds: 4 },
    ctx
  );

  // Wait until timeout elapses (4s)
  await new Promise(r => setTimeout(r, 4800));

  assert.equal(monitor.status, "timed_out");
  assert.ok(monitor.terminalReason.includes("Hard timeout"));
  assert.equal(mockAPI.sentMessages.length, 1);

  scheduler.pruneSession("s-time");
});

test("scheduler cancel stops polling, suppresses late notifications and clears status", async () => {
  const mockAPI = createMockAPI();
  let calls = 0;

  const toolExecutor = async () => {
    calls++;
    return { content: "processing", isError: false };
  };

  const scheduler = new MonitorScheduler(toolExecutor, mockAPI.api);
  const mock = createMockContext("s-cancel");

  const monitor = scheduler.startMonitor(
    "s-cancel",
    "test_tool",
    {},
    { textContains: "done" },
    { intervalSeconds: 2 },
    mock.ctx
  );

  // Cancel immediately after start
  const ok = scheduler.cancel(monitor.id, "User cancelled");
  assert.equal(ok, true);
  assert.equal(monitor.status, "cancelled");

  // Wait 2.5 seconds to ensure no background timer fired and no notification sent
  await new Promise(r => setTimeout(r, 2500));

  assert.equal(mockAPI.sentMessages.length, 0, "Cancelled monitor must NOT send completion notification");
  assert.equal(mock.statuses.get(`command:/monitor_cancel ${monitor.id}`), undefined, "Status button must be cleared");

  scheduler.pruneSession("s-cancel");
});
