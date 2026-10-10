import test from "node:test";
import assert from "node:assert/strict";
import { getNestedField, matchesTextMarker, deepEquals, matchesCondition } from "../src/matcher.ts";

test("getNestedField accesses nested object properties and arrays safely", () => {
  const obj = {
    status: "ok",
    data: {
      state: "printing",
      temperatures: [200, 210, 220],
      meta: {
        author: { name: "sample-user" }
      }
    }
  };

  assert.equal(getNestedField(obj, "status"), "ok");
  assert.equal(getNestedField(obj, "data.state"), "printing");
  assert.equal(getNestedField(obj, "data.temperatures.1"), 210);
  assert.equal(getNestedField(obj, "data.temperatures[2]"), 220);
  assert.equal(getNestedField(obj, "data.meta.author.name"), "sample-user");
  assert.equal(getNestedField(obj, "data.nonexistent"), undefined);
  assert.equal(getNestedField(null, "anything"), undefined);
});

test("matchesTextMarker protects against negative prefixes", () => {
  // Should NOT match negated occurrences
  assert.equal(matchesTextMarker("build: not completed", "completed"), false);
  assert.equal(matchesTextMarker("status: not: completed", "completed"), false);
  assert.equal(matchesTextMarker("job is uncompleted", "completed"), false);
  assert.equal(matchesTextMarker("task is non-completed", "completed"), false);
  assert.equal(matchesTextMarker("result: no completed items", "completed"), false);

  // Should match positive occurrences
  assert.equal(matchesTextMarker("build: completed", "completed"), true);
  assert.equal(matchesTextMarker("status is completed successfully", "completed"), true);
  assert.equal(matchesTextMarker("failed earlier, but now completed", "completed"), true);

  // Marker starting with negation should match directly
  assert.equal(matchesTextMarker("error: file not found", "not found"), true);
  assert.equal(matchesTextMarker("status: no connection", "no connection"), true);
});

test("deepEquals handles primitives, arrays, and objects", () => {
  assert.equal(deepEquals(42, 42), true);
  assert.equal(deepEquals("foo", "foo"), true);
  assert.equal(deepEquals([1, 2, 3], [1, 2, 3]), true);
  assert.equal(deepEquals([1, 2], [1, 3]), false);
  assert.equal(deepEquals({ a: 1, b: "x" }, { b: "x", a: 1 }), true);
  assert.equal(deepEquals({ a: 1 }, { a: 2 }), false);
});

test("matchesCondition: structured field equals and notEquals", () => {
  const result = {
    isError: false,
    content: "{}",
    structuredContent: { status: "success", count: 10 }
  };

  const condEquals = { field: "status", equals: "success" };
  assert.equal(matchesCondition(condEquals, result).matched, true);

  const condNotEquals = { field: "status", notEquals: "failed" };
  assert.equal(matchesCondition(condNotEquals, result).matched, true);

  const condWrongEquals = { field: "status", equals: "pending" };
  assert.equal(matchesCondition(condWrongEquals, result).matched, false);
});

test("matchesCondition: structured numeric comparisons and in operator", () => {
  const result = {
    isError: false,
    content: "{}",
    structuredContent: { progress: { percentage: 100 }, code: 200 }
  };

  assert.equal(matchesCondition({ field: "progress.percentage", greaterThanOrEqual: 100 }, result).matched, true);
  assert.equal(matchesCondition({ field: "progress.percentage", greaterThan: 99 }, result).matched, true);
  assert.equal(matchesCondition({ field: "progress.percentage", lessThan: 100 }, result).matched, false);
  assert.equal(matchesCondition({ field: "code", in: [200, 201, 204] }, result).matched, true);
  assert.equal(matchesCondition({ field: "code", in: [400, 500] }, result).matched, false);
});

test("matchesCondition: parses json content if structuredContent is missing", () => {
  const result = {
    isError: false,
    content: JSON.stringify({ state: "FINISHED", exitCode: 0 })
  };

  assert.equal(matchesCondition({ field: "state", equals: "FINISHED" }, result).matched, true);
  assert.equal(matchesCondition({ field: "exitCode", equals: 0 }, result).matched, true);
});

test("matchesCondition: textContains with negation protection", () => {
  const resultNegated = {
    isError: false,
    content: "Deploy stage 3: not ready"
  };
  assert.equal(matchesCondition({ textContains: "ready" }, resultNegated).matched, false);

  const resultPositive = {
    isError: false,
    content: "Deploy stage 3: ready"
  };
  assert.equal(matchesCondition({ textContains: "ready" }, resultPositive).matched, true);
});

test("matchesCondition: regex textMatches", () => {
  const result = {
    isError: false,
    content: "Build #104 finished with status SUCCESS in 42s"
  };
  assert.equal(matchesCondition({ textMatches: "status\\s+SUCCESS" }, result).matched, true);
  assert.equal(matchesCondition({ textMatches: "status\\s+FAILURE" }, result).matched, false);
});

test("matchesCondition: isError = true is NEVER a match", () => {
  const errorResult = {
    isError: true,
    content: '{"status": "completed"}',
    structuredContent: { status: "completed" }
  };

  assert.equal(matchesCondition({ field: "status", equals: "completed" }, errorResult).matched, false);
  assert.equal(matchesCondition({ textContains: "completed" }, errorResult).matched, false);
});
