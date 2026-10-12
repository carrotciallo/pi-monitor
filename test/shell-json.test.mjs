import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveStructuredSource,
  strictParseJson,
  isShellEnvelope,
  hasTruncationOrErrorWrapper,
} from "../src/shell-json.ts";
import { matchesCondition, observeConditionValue } from "../src/matcher.ts";

test("intact plain JSON text is adapted", () => {
  assert.deepEqual(resolveStructuredSource({ isError: false, content: '{"online":0,"max":10}' }), {
    value: { online: 0, max: 10 },
    kind: "json-content",
  });
  // Surrounding whitespace is not surrounding text.
  assert.deepEqual(resolveStructuredSource({ isError: false, content: '  {"a":1}\n' }), {
    value: { a: 1 },
    kind: "json-content",
  });
  assert.deepEqual(resolveStructuredSource({ isError: false, content: "42" }), { value: 42, kind: "json-content" });
});

test("truncation, timeout, kill and error wrappers are rejected, never stripped", () => {
  const wrapped = [
    '{"status":"done"}\n\n[Output truncated: showing 2 of 5 lines (30B of 90B). Full output saved to: /tmp/x]',
    '{"status":"done"}\n\n[Hypa command timed out or was killed]',
    '{"exit":0}\n\nCommand exited with code 1',
    '{"exit":0}\n\nCommand exited with code 0',
    '{"count":3}\n\n[Showing lines 1-1 of 1 (50.0KB limit). Full output: /tmp/y]',
    '{"count":3}\n\n[Showing last 1.0KB of line 5 (line is 5.0KB). Full output: /tmp/y]',
    '{"count":3}\n\nCommand timed out after 5 seconds',
    '{"count":3}\n\nCommand aborted',
    '{"count":3}\n\nCommand terminated without an exit code',
  ];
  for (const content of wrapped) {
    assert.equal(hasTruncationOrErrorWrapper(content), true, content);
    assert.equal(resolveStructuredSource({ isError: false, content }), undefined, content);
  }
  assert.equal(hasTruncationOrErrorWrapper('{"a":1}'), false);
});

test("the shell structuredContent envelope unwraps only for shell tools on success", () => {
  const envelope = { output: '{"online":0}', truncated: false, exit_code: 0, wall_time_seconds: 0.2 };
  assert.deepEqual(resolveStructuredSource({ isError: false, content: "ignored", structuredContent: envelope, toolName: "bash" }), {
    value: { online: 0 },
    kind: "shell-output",
  });
  assert.deepEqual(resolveStructuredSource({ isError: false, content: "ignored", structuredContent: envelope, toolName: "hypa_shell" }), {
    value: { online: 0 },
    kind: "shell-output",
  });

  // A failing command is never adapted.
  const failed = { output: '{"online":0}', truncated: false, exit_code: 1, wall_time_seconds: 0.2 };
  assert.equal(resolveStructuredSource({ isError: false, content: "", structuredContent: failed, toolName: "bash" }), undefined);

  // A non-shell tool with a lookalike envelope is never unwrapped; it stays an
  // ordinary structured object, and its `output` string is not parsed.
  assert.deepEqual(
    resolveStructuredSource({ isError: false, content: "", structuredContent: envelope, toolName: "some_status" }),
    { value: envelope, kind: "structured-content" },
  );
  // A missing tool name is also never treated as a shell tool.
  assert.deepEqual(
    resolveStructuredSource({ isError: false, content: "", structuredContent: envelope }),
    { value: envelope, kind: "structured-content" },
  );

  // Non-JSON shell output keeps the envelope itself, never a substring.
  const textEnvelope = { output: "(no output)", truncated: false, exit_code: 0, wall_time_seconds: 0.1 };
  assert.deepEqual(
    resolveStructuredSource({ isError: false, content: "", structuredContent: textEnvelope, toolName: "bash" }),
    { value: textEnvelope, kind: "structured-content" },
  );
});

test("a structured payload demoted to text by the MCP adapter is recovered exactly", () => {
  const payload = { page: 1, total: 3, emails: [{ subject: "hello" }] };
  const pretty = JSON.stringify(payload, null, 2);

  // The adapter appends the marker and pretty-printed JSON after the text blocks.
  const withText = '{"content":"ok"}' + "\n" + "structuredContent:\n" + pretty;
  assert.deepEqual(resolveStructuredSource({ isError: false, content: withText, toolName: "mail_list_emails_metadata" }), {
    value: payload,
    kind: "mcp-structured",
  });

  // With no ordinary content block the marker leads the text.
  assert.deepEqual(resolveStructuredSource({ isError: false, content: "structuredContent:\n" + pretty }), {
    value: payload,
    kind: "mcp-structured",
  });
});

test("recovering a demoted payload stays strict and never mistakes a marker inside the payload", () => {
  // A marker that does not start a line is not a delimiter.
  assert.equal(resolveStructuredSource({ isError: false, content: 'note structuredContent:\n{"a":1}' }), undefined);
  // A marker whose remainder is not intact JSON is rejected, not repaired.
  assert.equal(resolveStructuredSource({ isError: false, content: 'structuredContent:\n{"total":' }), undefined);
  // A truncation wrapper still wins over the marker.
  assert.equal(
    resolveStructuredSource({ isError: false, content: "structuredContent:\n{}\n[Output truncated: 5 lines]" }),
    undefined,
  );
  // A malformed marker at offset 0 terminates instead of being re-found forever.
  assert.equal(resolveStructuredSource({ isError: false, content: "structuredContent:\nnot json" }), undefined);
  // When the payload itself contains a marker line, the real (rightmost) one wins.
  const nested = { note: "structuredContent:\nfake", total: 2 };
  assert.deepEqual(
    resolveStructuredSource({ isError: false, content: "x\nstructuredContent:\n" + JSON.stringify(nested, null, 2) }),
    { value: nested, kind: "mcp-structured" },
  );
});

test("strict adaptation never performs fuzzy extraction", () => {
  // A JSON object embedded in surrounding text is not adapted.
  assert.equal(resolveStructuredSource({ isError: false, content: 'prefix {"a":1} suffix' }), undefined);
  // An unknown trailing footer is not removed, so the body is no longer JSON.
  assert.equal(resolveStructuredSource({ isError: false, content: '{"a":1}\n[unknown footer]' }), undefined);
  assert.equal(resolveStructuredSource({ isError: false, content: "not json" }), undefined);
  assert.equal(resolveStructuredSource({ isError: false, content: "" }), undefined);
  // A valid JSON prefix followed by omitted output must not be accepted.
  assert.equal(resolveStructuredSource({ isError: false, content: '{"items":[1,2,3],"trunc' }), undefined);

  assert.deepEqual(strictParseJson("  {\"a\":1}  "), { a: 1 });
  assert.equal(strictParseJson("{bad"), undefined);
  assert.equal(strictParseJson(""), undefined);
  assert.equal(isShellEnvelope({ output: "x" }), false);
  assert.equal(isShellEnvelope({ output: "x", exit_code: 0 }), true);
  assert.equal(isShellEnvelope([1, 2]), false);
});

test("field conditions use strict adaptation and reject truncated shell output", () => {
  const hypa = { isError: false, content: '{"online":0,"max":20}', toolName: "hypa_shell" };
  assert.equal(matchesCondition({ field: "online", equals: 0 }, hypa).matched, true);
  assert.equal(matchesCondition({ field: "max", greaterThan: 10 }, hypa).matched, true);
  assert.equal(matchesCondition({ field: "online", equals: 1 }, hypa).matched, false);

  const truncated = {
    isError: false,
    content: '{"online":0}\n\n[Output truncated: showing 1 of 3 lines (10B of 30B). Full output saved to: /tmp/z]',
    toolName: "hypa_shell",
  };
  // The truncated body must not match on its surviving prefix.
  assert.equal(matchesCondition({ field: "online", equals: 0 }, truncated).matched, false);

  const embedded = { isError: false, content: 'status: {"online":0}' };
  assert.equal(matchesCondition({ field: "online", equals: 0 }, embedded).matched, false);
});

test("host structured objects still validate before adaptation, without invoking getters", () => {
  let calls = 0;
  const accessor = { get state() { calls++; return "done"; } };
  const result = matchesCondition({ field: "state", equals: "done" }, {
    isError: false, content: "", structuredContent: accessor,
  });
  assert.equal(result.matched, false);
  assert.match(result.reason, /Invalid monitor input/);
  assert.equal(calls, 0, "getters are never executed");
});

test("observed values are bounded, single-line and redacted for sensitive fields", () => {
  const chatty = {
    isError: false,
    content: "",
    structuredContent: { state: "PRINTING", message: "x".repeat(500), apiToken: "sk-secret" },
  };
  const observed = observeConditionValue({ field: "state", equals: "PRINTING" }, chatty);
  assert.equal(observed.field, "state");
  assert.equal(observed.value, "PRINTING");
  assert.ok(observed.value.length <= 81);

  const long = observeConditionValue({ field: "message", contains: "x" }, chatty);
  assert.ok(Array.from(long.value).length <= 81);
  assert.match(long.value, /…$/);

  const secret = observeConditionValue({ field: "apiToken", equals: "sk-secret" }, chatty);
  assert.equal(secret.value, "[REDACTED]");

  // Non-field conditions have no single relevant field.
  assert.equal(observeConditionValue({ textContains: "PRINTING" }, chatty), undefined);
  // Errors are never observed samples.
  assert.equal(observeConditionValue({ field: "state", equals: "x" }, { ...chatty, isError: true }), undefined);
});

test("observed values render scalars only and never nested object contents", () => {
  const result = {
    isError: false,
    content: "",
    structuredContent: {
      state: "UP",
      count: 3,
      ratio: 0.5,
      flag: true,
      meta: { apiToken: "sk-nested-secret", nested: { deep: "value" } },
      items: [{ secret: "a" }, { secret: "b" }],
    },
  };

  assert.equal(observeConditionValue({ field: "state", equals: "UP" }, result).value, "UP");
  assert.equal(observeConditionValue({ field: "count", equals: 3 }, result).value, "3");
  assert.equal(observeConditionValue({ field: "ratio", equals: 0.5 }, result).value, "0.5");
  assert.equal(observeConditionValue({ field: "flag", equals: true }, result).value, "true");

  // Composite values collapse to a placeholder; nested secrets never render.
  assert.equal(observeConditionValue({ field: "meta", equals: 1 }, result).value, "[object]");
  assert.equal(observeConditionValue({ field: "items", equals: 1 }, result).value, "[array: 2]");
  for (const field of ["meta", "items"]) {
    assert.doesNotMatch(observeConditionValue({ field, equals: 1 }, result).value, /sk-|secret|deep/);
  }
});

test("observed field labels are bounded", () => {
  const longField = "a".repeat(200);
  const result = { isError: false, content: "", structuredContent: { [longField]: 1 } };
  const observed = observeConditionValue({ field: longField, equals: 1 }, result);
  assert.ok(Array.from(observed.field).length <= 61);
  assert.match(observed.field, /…$/);
});
