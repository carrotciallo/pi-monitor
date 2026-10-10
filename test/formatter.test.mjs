import test from "node:test";
import assert from "node:assert/strict";
import { formatWidgetLines } from "../src/formatter.ts";

function record(id, status, createdAt) {
  return { id, status, createdAt, startedAt: createdAt, attempts: 1, consecutiveErrors: 0,
    tool: "read", condition: { textContains: "done" },
    options: { description: id, intervalSeconds: 5, timeoutSeconds: 60 } };
}

test("running tasks stay visible ahead of retained terminal history", () => {
  const records = [record("old-cancelled", "cancelled", 1), record("active", "running", 2)];
  const text = formatWidgetLines(records).join("\n");
  assert.match(text, /active/);
  assert.doesNotMatch(text, /old-cancelled/);
  assert.equal(formatWidgetLines(records).length, 1);
  assert.doesNotMatch(text, /text contains|total tasks|monitor_cancel/);
  assert.deepEqual(records.map(r => r.id), ["old-cancelled", "active"]);
});

test("terminal display prioritizes recent records and bounds visible history", () => {
  const records = Array.from({ length: 10 }, (_, i) => record(`history-${i}`, "cancelled", i));
  const text = formatWidgetLines(records).join("\n");
  assert.match(text, /history-9/);
  assert.doesNotMatch(text, /history-8|history-0/);
  assert.equal(formatWidgetLines(records).length, 1);
});
