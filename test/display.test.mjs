import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDisplaySpecs, observeDisplayValues } from "../src/display.ts";
import { formatWidgetLines, formatDisplayValues } from "../src/formatter.ts";
import { MAX_OBSERVED_VALUE_LENGTH } from "../src/matcher.ts";
import { MAX_DISPLAY_FIELDS } from "../src/types.ts";

/** A successful poll result carrying a structured payload. */
function result(value, overrides = {}) {
  return { isError: false, content: "", structuredContent: value, toolName: "read", ...overrides };
}

test("normalizeDisplaySpecs accepts a plain field and defaults the label", () => {
  const specs = normalizeDisplaySpecs([{ field: "downloaded" }]);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].field, "downloaded");
  assert.equal(specs[0].label, "downloaded");
});

test("normalizeDisplaySpecs drops duplicate labels and caps the field count", () => {
  const dupes = normalizeDisplaySpecs([
    { field: "a", label: "progress" },
    { field: "b", label: "progress" },
  ]);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].field, "a");

  const tooMany = Array.from({ length: MAX_DISPLAY_FIELDS + 1 }, (_, i) => ({ field: `f${i}` }));
  assert.throws(() => normalizeDisplaySpecs(tooMany), new RegExp(`at most ${MAX_DISPLAY_FIELDS}`));
});

test("normalizeDisplaySpecs rejects malformed declarations loudly", () => {
  assert.throws(() => normalizeDisplaySpecs("downloaded"), /must be an array/);
  assert.throws(() => normalizeDisplaySpecs([{ label: "no field" }]), /needs a nonempty 'field'/);
  assert.throws(() => normalizeDisplaySpecs([{ field: "" }]), /needs a nonempty 'field'/);
  assert.throws(() => normalizeDisplaySpecs([{ field: "a", total: Number.NaN }]), /finite number/);
  assert.throws(() => normalizeDisplaySpecs([{ field: "a", total: Infinity }]), /finite number/);
  assert.throws(() => normalizeDisplaySpecs([{ field: "a", totalField: 5 }]), /totalField must be a nonempty string/);
  assert.throws(() => normalizeDisplaySpecs([null]), /must be an object/);
  assert.equal(normalizeDisplaySpecs(undefined), undefined);
});

test("a progress pair renders as value/total from a fixed total", () => {
  const specs = normalizeDisplaySpecs([{ field: "downloaded", total: 1000 }]);
  const values = observeDisplayValues(specs, result({ downloaded: 530 }));
  assert.deepEqual(values, [{ label: "downloaded", value: "530/1000" }]);
});

test("a progress pair renders from a sibling totalField, which wins over fixed total", () => {
  const specs = normalizeDisplaySpecs([
    { field: "downloaded", total: 1, totalField: "totalBytes" },
  ]);
  const values = observeDisplayValues(specs, result({ downloaded: 530, totalBytes: 1000 }));
  assert.deepEqual(values, [{ label: "downloaded", value: "530/1000" }]);
});

test("multiple display fields render in declared order", () => {
  const specs = normalizeDisplaySpecs([
    { field: "downloaded", label: "progress", totalField: "totalBytes" },
    { field: "speed", label: "speed" },
  ]);
  const values = observeDisplayValues(specs, result({ downloaded: 530, totalBytes: 1000, speed: "1.2MB/s" }));
  assert.deepEqual(values, [
    { label: "progress", value: "530/1000" },
    { label: "speed", value: "1.2MB/s" },
  ]);
});

test("sensitive field paths are redacted", () => {
  const specs = normalizeDisplaySpecs([{ field: "apiKey" }, { field: "auth.token" }]);
  const values = observeDisplayValues(specs, result({ apiKey: "sk-secret", auth: { token: "t" } }));
  assert.deepEqual(values.map(v => v.value), ["[REDACTED]", "[REDACTED]"]);
});

test("control characters and ANSI escapes are stripped from rendered values", () => {
  const specs = normalizeDisplaySpecs([{ field: "state", label: "st\x1b[31mate" }]);
  const values = observeDisplayValues(specs, result({ state: "ab\x1b[31mcd\x07ef" }));
  // The ESC and BEL bytes are removed, so the residual "[31m" is inert literal
  // text with no terminal control. Same behavior as the observed-value line.
  assert.equal(values[0].value, "ab [31mcd ef");
  assert.equal(values[0].label, "st [31mate");
  assert.doesNotMatch(values[0].value, /\x1b/);
  assert.doesNotMatch(values[0].label, /\x1b/);
});

test("values are bounded to the observed-value length", () => {
  const specs = normalizeDisplaySpecs([{ field: "blob" }]);
  const values = observeDisplayValues(specs, result({ blob: "x".repeat(500) }));
  assert.equal(Array.from(values[0].value).length, MAX_OBSERVED_VALUE_LENGTH + 1); // + ellipsis
  assert.ok(values[0].value.endsWith("…"));
});

test("composite values collapse instead of leaking nested contents", () => {
  const specs = normalizeDisplaySpecs([{ field: "meta" }, { field: "items" }]);
  const values = observeDisplayValues(specs, result({ meta: { secret: "deep" }, items: [1, 2, 3] }));
  assert.deepEqual(values.map(v => v.value), ["[object]", "[array: 3]"]);
  assert.doesNotMatch(JSON.stringify(values), /deep/);
});

test("a missing field or a failed query yields no display values", () => {
  const specs = normalizeDisplaySpecs([{ field: "downloaded" }]);
  assert.equal(observeDisplayValues(specs, result({ other: 1 })), undefined);
  assert.equal(observeDisplayValues(specs, result({ downloaded: 5 }, { isError: true })), undefined);
  assert.equal(observeDisplayValues(undefined, result({ downloaded: 5 })), undefined);
});

test("formatDisplayValues joins segments and formatWidgetLines includes them", () => {
  const record = {
    id: "m1", status: "running", createdAt: 1, startedAt: 1, attempts: 3, consecutiveErrors: 0,
    tool: "read", condition: { textContains: "done" },
    options: { description: "Download", intervalSeconds: 5, timeoutSeconds: 60 },
    displayValues: [{ label: "downloaded", value: "530/1000" }],
  };
  assert.equal(formatDisplayValues(record), "downloaded=530/1000");
  const line = formatWidgetLines([record]).join("\n");
  assert.match(line, /downloaded=530\/1000/);
});

test("records without display values render exactly as before", () => {
  const record = {
    id: "m1", status: "running", createdAt: 1, startedAt: 1, attempts: 2, consecutiveErrors: 0,
    tool: "read", condition: { textContains: "done" },
    options: { description: "Plain", intervalSeconds: 5, timeoutSeconds: 60 },
  };
  assert.equal(formatDisplayValues(record), undefined);
  assert.doesNotMatch(formatWidgetLines([record]).join("\n"), /undefined|null/);
});
