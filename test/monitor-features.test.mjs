import test from "node:test";
import assert from "node:assert/strict";
import { MonitorScheduler } from "../src/scheduler.ts";
import { formatWidgetLines, formatHealthSuffix, formatObservedValue } from "../src/formatter.ts";
import { STATE_ENTRY_TYPE } from "../src/types.ts";

function ctxFor(sessionId = "feat", entries = []) {
  return {
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
    },
    ui: { setWidget() {}, setStatus() {}, notify() {} },
  };
}

function apiWithSpy() {
  const messages = [];
  const appended = [];
  return {
    messages,
    appended,
    api: {
      sendMessage: (msg, opts) => messages.push({ msg, opts }),
      appendEntry: (type, data) => appended.push({ type, data }),
      getAllTools: () => [],
      on: () => () => {},
      registerTool() {},
      registerCommand() {},
    },
  };
}

test("exact dedupe reuses an identical running monitor and reports reused:true", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const ctx = ctxFor("dedupe");

  const first = scheduler.startOrReuseMonitor(
    "dedupe", "job_status", { id: "42", verbose: true }, { field: "state", equals: "done" },
    { intervalSeconds: 5, timeoutSeconds: 60, consecutiveMatches: 2 }, ctx,
  );
  assert.equal(first.reused, false);

  // Argument key order does not matter: canonical JSON identity.
  const second = scheduler.startOrReuseMonitor(
    "dedupe", "job_status", { verbose: true, id: "42" }, { field: "state", equals: "done" },
    { intervalSeconds: 5, timeoutSeconds: 60, consecutiveMatches: 2 }, ctx,
  );
  assert.equal(second.reused, true);
  assert.equal(second.record.id, first.record.id);
  assert.equal(scheduler.getSessionRecords("dedupe").length, 1);

  // A different description is only a label and still reuses.
  const labelled = scheduler.startOrReuseMonitor(
    "dedupe", "job_status", { id: "42", verbose: true }, { field: "state", equals: "done" },
    { intervalSeconds: 5, timeoutSeconds: 60, consecutiveMatches: 2, description: "another label" }, ctx,
  );
  assert.equal(labelled.reused, true);
  assert.equal(labelled.record.id, first.record.id);

  // Different stability config is a different monitor.
  const different = scheduler.startOrReuseMonitor(
    "dedupe", "job_status", { id: "42", verbose: true }, { field: "state", equals: "done" },
    { intervalSeconds: 5, timeoutSeconds: 60, consecutiveMatches: 3 }, ctx,
  );
  assert.equal(different.reused, false);
  assert.notEqual(different.record.id, first.record.id);

  // Terminal monitors are not reused.
  scheduler.cancel(first.record.id, "test", "dedupe");
  const afterCancel = scheduler.startOrReuseMonitor(
    "dedupe", "job_status", { id: "42", verbose: true }, { field: "state", equals: "done" },
    { intervalSeconds: 5, timeoutSeconds: 60, consecutiveMatches: 2 }, ctx,
  );
  assert.equal(afterCancel.reused, false);

  scheduler.pruneSession("dedupe");
});

test("a different display declaration never reuses a running monitor", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const ctx = ctxFor("display-dedupe");
  const base = { intervalSeconds: 5, timeoutSeconds: 60 };

  const first = scheduler.startOrReuseMonitor(
    "display-dedupe", "job_status", { id: "42" }, { field: "state", equals: "done" },
    { ...base, display: [{ field: "downloaded", label: "downloaded" }] }, ctx,
  );
  assert.equal(first.reused, false);

  // Identical declaration (same field, label defaulted) still reuses.
  const same = scheduler.startOrReuseMonitor(
    "display-dedupe", "job_status", { id: "42" }, { field: "state", equals: "done" },
    { ...base, display: [{ field: "downloaded", label: "downloaded" }] }, ctx,
  );
  assert.equal(same.reused, true);
  assert.equal(same.record.id, first.record.id);

  // A different projection is a different monitor: reusing would silently keep
  // the old record's display and never show the newly declared field.
  const different = scheduler.startOrReuseMonitor(
    "display-dedupe", "job_status", { id: "42" }, { field: "state", equals: "done" },
    { ...base, display: [{ field: "percent" }] }, ctx,
  );
  assert.equal(different.reused, false);
  assert.notEqual(different.record.id, first.record.id);

  // No display at all is distinct from any display.
  const none = scheduler.startOrReuseMonitor(
    "display-dedupe", "job_status", { id: "42" }, { field: "state", equals: "done" },
    base, ctx,
  );
  assert.equal(none.reused, false);

  scheduler.pruneSession("display-dedupe");
});

test("dedupe is scoped to the session and rejects non-canonical arguments", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const a = scheduler.startOrReuseMonitor("s-a", "read", { p: 1 }, { textContains: "x" }, {}, ctxFor("s-a"));
  const b = scheduler.startOrReuseMonitor("s-b", "read", { p: 1 }, { textContains: "x" }, {}, ctxFor("s-b"));
  assert.equal(a.record.id === b.record.id, false);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => scheduler.startOrReuseMonitor("s-a", "read", cyclic, { textContains: "x" }, {}, ctxFor("s-a")),
    /not canonical JSON/,
  );

  scheduler.pruneSession("s-a");
  scheduler.pruneSession("s-b");
});

test("consecutiveMatches requires N observed matches and resets on a miss", async () => {
  const api = apiWithSpy();
  const sequence = [true, true, false, true, true, true];
  let calls = 0;
  const scheduler = new MonitorScheduler(async () => {
    const matched = sequence[calls++] ?? true;
    return { content: "{}", structuredContent: { online: matched ? 0 : 1 }, isError: false };
  }, api.api);
  const ctx = ctxFor("cm");

  const record = scheduler.startMonitor(
    "cm", "read", {}, { field: "online", equals: 0 },
    { intervalSeconds: 2, consecutiveMatches: 3, timeoutSeconds: 30 }, ctx,
  );

  // After the miss at attempt 3 the progress resets; completion needs 3 more.
  await new Promise(r => setTimeout(r, 12800));

  assert.equal(record.status, "completed");
  assert.equal(record.attempts, 6);
  assert.equal(record.consecutiveMatches, 3);
  assert.equal(api.messages.length, 1);
  assert.match(record.terminalReason, /3\/3 matches/);

  scheduler.pruneSession("cm");
});

test("errors reset match progress and do not count as observed samples", async () => {
  const api = apiWithSpy();
  let calls = 0;
  const scheduler = new MonitorScheduler(async () => {
    calls++;
    // match, then an error, then matches again
    if (calls === 2) return { content: "", isError: true, errorText: "transient" };
    return { content: "{}", structuredContent: { online: 0 }, isError: false };
  }, api.api);

  const record = scheduler.startMonitor(
    "err", "read", {}, { field: "online", equals: 0 },
    { intervalSeconds: 2, consecutiveMatches: 2, maxRetries: 5, timeoutSeconds: 30 }, ctxFor("err"),
  );

  await new Promise(r => setTimeout(r, 1000));
  assert.equal(record.consecutiveMatches, 1);
  assert.equal(record.lastSuccessAt > 0, true);

  await new Promise(r => setTimeout(r, 2500));
  assert.equal(record.consecutiveErrors, 1);
  assert.equal(record.consecutiveMatches, 0, "an error resets match progress");
  assert.equal(record.lastErrorAt > 0, true);

  scheduler.pruneSession("err");
});

test("stableForSeconds requires the match to persist before completing", async () => {
  const api = apiWithSpy();
  const scheduler = new MonitorScheduler(async () => ({
    content: "{}", structuredContent: { online: 0 }, isError: false,
  }), api.api);

  const record = scheduler.startMonitor(
    "stable", "read", {}, { field: "online", equals: 0 },
    { intervalSeconds: 2, consecutiveMatches: 2, stableForSeconds: 4, timeoutSeconds: 30 }, ctxFor("stable"),
  );

  // Two matches arrive by ~4.5s, but 4s of stability is required.
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(record.status, "running", "still running while stability accrues");

  await new Promise(r => setTimeout(r, 2500));
  assert.equal(record.status, "completed");
  assert.match(record.terminalReason, /stable:/);

  scheduler.pruneSession("stable");
});

test("health fields track last success, next check, errors and match progress", async () => {
  const api = apiWithSpy();
  let calls = 0;
  const scheduler = new MonitorScheduler(async () => {
    calls++;
    if (calls === 2) return { content: "", isError: true, errorText: "boom" };
    return { content: "{}", structuredContent: { state: "HEATING", online: 7 }, isError: false };
  }, api.api);

  const record = scheduler.startMonitor(
    "health", "read", {}, { field: "state", equals: "PRINTING" },
    { intervalSeconds: 2, maxRetries: 5, timeoutSeconds: 30 }, ctxFor("health"),
  );

  await new Promise(r => setTimeout(r, 1000));
  assert.equal(typeof record.lastAttemptAt, "number");
  assert.equal(typeof record.lastSuccessAt, "number");
  assert.equal(typeof record.nextCheckAt, "number");
  assert.ok(record.lastObservedValue, "a relevant field value is observed");
  assert.equal(record.lastObservedValue.field, "state");
  assert.equal(record.lastObservedValue.value, "HEATING");

  await new Promise(r => setTimeout(r, 2500));
  assert.equal(record.consecutiveErrors, 1);
  assert.equal(record.lastErrorText, "boom");
  assert.equal(record.lastObservedValue, undefined, "an error clears the observed value");

  scheduler.pruneSession("health");
});

test("a successful sample that drops the observed field clears the stale UI value", async () => {
  const uiSnapshots = [];
  let calls = 0;
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "stale" },
    ui: {
      setWidget(_key, lines) { if (lines) uiSnapshots.push(lines.join("\n")); },
      setStatus() {},
      notify() {},
    },
  };
  const scheduler = new MonitorScheduler(async () => {
    calls++;
    if (calls === 1) return { content: "{}", structuredContent: { state: "UP" }, isError: false };
    return { content: "{}", structuredContent: {}, isError: false };
  }, { appendEntry() {} });

  const record = scheduler.startOrReuseMonitor("stale", "read", {}, { field: "state", equals: "UP" }, {
    intervalSeconds: 2, consecutiveMatches: 5, timeoutSeconds: 30,
  }, ctx).record;

  await new Promise(r => setTimeout(r, 1000));
  assert.equal(record.lastObservedValue.value, "UP");

  await new Promise(r => setTimeout(r, 2500));
  assert.equal(record.lastObservedValue, undefined, "the disappeared field is cleared, not stale");
  // No rendered snapshot may show the stale state=UP after the field vanished.
  assert.doesNotMatch(uiSnapshots.at(-1), /state=UP/);
  // The health line reports the scheduled next check.
  assert.match(uiSnapshots.at(-1), /next \d+s/);

  scheduler.pruneSession("stale");
});

test("widget and health formatters expose concise relevant field values", () => {
  const record = {
    id: "mon_1", status: "running", createdAt: 1, startedAt: 1, attempts: 4,
    consecutiveErrors: 1, consecutiveMatches: 2, firstMatchAt: Date.now() - 4000,
    lastSuccessAt: Date.now() - 3000,
    tool: "read", condition: { field: "state", equals: "PRINTING" },
    options: { description: "Wait", intervalSeconds: 5, timeoutSeconds: 60, consecutiveMatches: 3, stableForSeconds: 10 },
    lastObservedValue: { field: "state", value: "HEATING", matched: false },
    nextCheckAt: Date.now() + 5000,
  };
  const text = formatWidgetLines([record], Date.now()).join("\n");
  assert.match(text, /match 2\/3/);
  assert.match(text, /errors 1/);
  assert.match(text, /stable \d+s\/10s/);
  assert.match(text, /ok \d+s ago/);
  assert.match(text, /state=HEATING/);
  assert.match(text, /next \d+s/);
  assert.equal(formatObservedValue(record), "state=HEATING");
  const health = formatHealthSuffix(record, Date.now());
  assert.match(health, /match 2\/3/);
  assert.match(health, /stable \d+s\/10s/);
  assert.match(health, /ok \d+s ago/);
  // The widget never renders the full result content.
  assert.doesNotMatch(text, /structuredContent|lastResult/);
});
