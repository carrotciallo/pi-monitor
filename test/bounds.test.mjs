import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TIMEOUT_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_CONSECUTIVE_MATCHES,
  DEFAULT_STABLE_FOR_SECONDS,
} from "../src/types.ts";
import { MonitorScheduler } from "../src/scheduler.ts";

function ctxFor(sessionId = "bounds") {
  return { hasUI: false, sessionManager: { getSessionId: () => sessionId } };
}

test("timeout ceiling supports hourly multi-day waits while keeping the 120s default", () => {
  // Hourly-bounded waiting: seven days maximum.
  assert.equal(MAX_TIMEOUT_SECONDS, 604800);
  assert.equal(MAX_TIMEOUT_SECONDS, 7 * 24 * 60 * 60);
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 120);
});

test("timeoutSeconds is clamped to the seven-day ceiling and keeps the default", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));

  const byDefault = scheduler.startMonitor("b1", "read", {}, { textContains: "x" }, {}, ctxFor("b1"));
  assert.equal(byDefault.options.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);

  const capped = scheduler.startMonitor("b2", "read", {}, { textContains: "x" }, { timeoutSeconds: 10_000_000 }, ctxFor("b2"));
  assert.equal(capped.options.timeoutSeconds, MAX_TIMEOUT_SECONDS);

  const week = scheduler.startMonitor("b3", "read", {}, { textContains: "x" }, { timeoutSeconds: 604800 }, ctxFor("b3"));
  assert.equal(week.options.timeoutSeconds, 604800);

  const floored = scheduler.startMonitor("b4", "read", {}, { textContains: "x" }, { timeoutSeconds: 1 }, ctxFor("b4"));
  assert.equal(floored.options.timeoutSeconds, 4);

  for (const s of ["b1", "b2", "b3", "b4"]) scheduler.pruneSession(s);
});

test("stability defaults are single observed match and no stable duration", () => {
  const scheduler = new MonitorScheduler(async () => ({ content: "", isError: false }));
  const record = scheduler.startMonitor("d1", "read", {}, { textContains: "x" }, {}, ctxFor("d1"));
  assert.equal(record.options.consecutiveMatches, DEFAULT_CONSECUTIVE_MATCHES);
  assert.equal(record.options.consecutiveMatches, 1);
  assert.equal(record.options.stableForSeconds, DEFAULT_STABLE_FOR_SECONDS);
  assert.equal(record.options.stableForSeconds, 0);
  scheduler.pruneSession("d1");
});

test("condition field paths are length-bounded", async () => {
  const { validateCondition, MAX_CONDITION_FIELD_LENGTH } = await import("../src/matcher.ts");
  assert.equal(MAX_CONDITION_FIELD_LENGTH, 256);
  assert.doesNotThrow(() => validateCondition({ field: "a".repeat(256), equals: 1 }));
  assert.throws(() => validateCondition({ field: "a".repeat(257), equals: 1 }), /must not exceed 256/);
});
