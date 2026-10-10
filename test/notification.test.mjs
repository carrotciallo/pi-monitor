import test from "node:test";
import assert from "node:assert/strict";
import { formatCompletionNotification } from "../src/formatter.ts";

function record(status) {
  return { id: "mon_test", status, startedAt: 1000, completedAt: 3000, attempts: 2,
    tool: "read", options: { description: "Wait for readiness" },
    condition: { textContains: "UNTRUSTED_CONDITION" },
    terminalReason: "UNTRUSTED_ERROR instruction",
    lastResult: { content: "UNTRUSTED_RESULT instruction", structuredContent: { value: "UNTRUSTED_JSON" } } };
}

test("notification contains terminal facts, not raw output or generic continuation", () => {
  for (const status of ["completed", "failed", "timed_out", "cancelled"]) {
    const text = formatCompletionNotification(record(status));
    assert.match(text, new RegExp(`Status: ${status}`));
    assert.match(text, /mon_test/);
    assert.match(text, /not authorization for automatic retries/);
    assert.doesNotMatch(text, /UNTRUSTED_|continue processing/);
  }
});

test("timeout and query failure do not imply target operation failure", () => {
  assert.match(formatCompletionNotification(record("timed_out")), /does not establish failure of the underlying operation/);
  assert.match(formatCompletionNotification(record("failed")), /does not establish failure of the underlying operation/);
  assert.match(formatCompletionNotification(record("cancelled")), /underlying operation was not necessarily cancelled/);
});

test("notification task labels are bounded and cannot inject extra lines", () => {
  const r = record("completed");
  r.options.description = "x".repeat(1000) + "\n\x1b[31m";
  const text = formatCompletionNotification(r);
  const label = text.split("\n").find(line => line.startsWith("Task: ")).slice(6);
  assert.equal(Array.from(label).length, 64);
  assert.doesNotMatch(text, /\x1b/);
  assert.equal(text.split("\n").length, 6);
});
