import { RE2JS } from "re2js";
import { createHash } from "node:crypto";
import { resolveStructuredSource } from "./shell-json.ts";
import type { MatchEvaluationResult, MonitorCondition, ObservedValue } from "./types.ts";

const VALID_FIELD_OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "greaterThan",
  "lessThan",
  "greaterThanOrEqual",
  "lessThanOrEqual",
  "contains",
] as const;

export function validateCondition(condition: MonitorCondition): void {
  canonicalJson(condition);
  if (!condition || typeof condition !== "object") {
    throw new Error("Condition must be a non-null object");
  }

  if ("field" in condition) {
    if (typeof condition.field !== "string" || !condition.field.trim()) {
      throw new Error("FieldCondition 'field' must be a non-empty string");
    }
    if (condition.field.length > MAX_CONDITION_FIELD_LENGTH) {
      throw new Error(`FieldCondition 'field' must not exceed ${MAX_CONDITION_FIELD_LENGTH} characters`);
    }
    const condRecord = condition as unknown as Record<string, unknown>;
    const specifiedOps = VALID_FIELD_OPERATORS.filter(op => condRecord[op] !== undefined);
    if (specifiedOps.length !== 1) {
      throw new Error(
        `FieldCondition must specify exactly one operator (${VALID_FIELD_OPERATORS.join(", ")}). Found ${specifiedOps.length}: ${specifiedOps.join(", ") || "none"}`
      );
    }
    if (condition.in !== undefined && (!Array.isArray(condition.in) || condition.in.length === 0)) {
      throw new Error("FieldCondition 'in' operator must be a non-empty array");
    }
    return;
  }

  if ("textContains" in condition) {
    if (typeof condition.textContains !== "string" || !condition.textContains.trim()) {
      throw new Error("textContains must be a non-empty string");
    }
    if (condition.textContains.length > 300) {
      throw new Error("textContains must not exceed 300 characters");
    }
    return;
  }

  if ("textMatches" in condition) {
    if (typeof condition.textMatches !== "string" || !condition.textMatches.trim()) {
      throw new Error("textMatches must be a non-empty string");
    }
    if (condition.textMatches.length > 200) {
      throw new Error("textMatches regex pattern length must not exceed 200 characters");
    }
    // RE2JS uses linear-time matching rather than JavaScript backtracking.
    try {
      RE2JS.compile(condition.textMatches);
    } catch (e) {
      throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if ("resultSha256" in condition) {
    if (typeof condition.resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(condition.resultSha256)) {
      throw new Error("resultSha256 must be a 64-character lowercase hex string");
    }
    return;
  }

  throw new Error("Unsupported condition format");
}

/**
 * Safely access nested object properties using dot or bracket notation.
 * Prevents prototype pollution and access to inherited prototype properties.
 * e.g., "data.status", "jobs[0].state", "items.1.result"
 */
export function getNestedField(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return undefined;
  }

  // Normalize path: replace [0] with .0
  const normalizedPath = path.replace(/\[(\w+)\]/g, ".$1");
  const segments = normalizedPath.split(".").map(s => s.trim()).filter(Boolean);

  let current: unknown = obj;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    // Block prototype pollution properties
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      return undefined;
    }
    // Block inherited properties
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Checks if a string contains a marker while preventing false positives
 * from common negation prefixes (e.g. "not completed", "not yet completed", "uncompleted", "incompleted").
 */
export function matchesTextMarker(text: string, marker: string): boolean {
  if (!text || !marker || !text.includes(marker)) {
    return false;
  }

  const trimmedMarker = marker.trim();
  // If marker itself begins with a negation prefix (e.g. "not found", "no items"), allow direct match.
  if (/^\b(not|no|un|non|in)\b/i.test(trimmedMarker)) {
    return true;
  }

  let index = 0;
  while ((index = text.indexOf(marker, index)) !== -1) {
    // 1. Check if preceded immediately by word-combining negation prefix (e.g. "incompleted", "uncompleted", "nonfunctional")
    const immediatePreceding = text.slice(Math.max(0, index - 5), index);
    if (/(?:^|\W)(?:in|un|non|dis)$/i.test(immediatePreceding)) {
      index += marker.length;
      continue;
    }

    // 2. Check preceding text up to 32 characters before the marker for negative word phrases
    const prefix = text.slice(Math.max(0, index - 32), index);
    const isNegated = /\b(?:not\s+yet|not\s+quite|not\s+fully|not\s+completely|not|no|un|non|in)\s*[-:]?\s*$/i.test(prefix);
    if (!isNegated) {
      return true;
    }
    index += marker.length;
  }

  return false;
}

/**
 * Deep equality helper with circular reference detection and recursion depth cap.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (typeof a !== typeof b) return false;
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

/**
 * Standard canonical JSON serialization: sorted keys, omit undefined, arrays retain order.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function sort(v: unknown, depth = 0): unknown {
    if (++nodes > 10000 || depth > 32) throw new Error("JSON input exceeds complexity limit");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (v === undefined) return null;
    if (typeof v !== "object") throw new Error("Unsupported non-JSON input");
    if (ancestors.has(v)) throw new Error("Circular JSON input");
    const prototype = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error("Unsupported non-JSON object");
    }
    ancestors.add(v);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Object.values(descriptors).some(d => d.get || d.set)) throw new Error("JSON accessors are not allowed");
      if (Array.isArray(v)) return v.map(item => sort(item, depth + 1));
      return Object.fromEntries(Object.keys(descriptors).sort()
        .filter(key => descriptors[key].enumerable && descriptors[key].value !== undefined)
        .map(key => [key, sort(descriptors[key].value, depth + 1)]));
    } finally {
      ancestors.delete(v);
    }
  }
  const json = JSON.stringify(sort(value));
  if (json.length > 262144) throw new Error("JSON input exceeds size limit");
  return json;
}

export function computeSha256(val: unknown): string {
  return createHash("sha256").update(canonicalJson(val)).digest("hex");
}

/**
 * Evaluates whether a tool result satisfies the monitor condition.
 */
export function matchesCondition(
  condition: MonitorCondition,
  result: { isError: boolean; content: string; structuredContent?: unknown; toolName?: string },
): MatchEvaluationResult {
  try {
    // Validate condition and any host structured value BEFORE adaptation, so
    // exotic accessors are rejected by canonicalJson rather than being executed.
    canonicalJson(condition);
    if (result.structuredContent !== undefined) canonicalJson(result.structuredContent);
    return evaluateCondition(condition, result);
  } catch (error) {
    return { matched: false, reason: `Invalid monitor input: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function evaluateCondition(
  condition: MonitorCondition,
  result: { isError: boolean; content: string; structuredContent?: unknown; toolName?: string },
): MatchEvaluationResult {
  // RULE 1: An execution error is NEVER a successful condition match.
  if (result.isError) {
    return { matched: false, reason: "Tool execution returned an error" };
  }

  // Pre-validate condition
  try {
    validateCondition(condition);
  } catch (err) {
    return { matched: false, reason: `Invalid condition: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Truncate candidate content for safety
  const safeContent = (result.content ?? "").slice(0, 65536);

  // 1. Field condition (structured)
  if ("field" in condition) {
    // Strict adaptation: structuredContent, a known shell envelope (only for
    // shell tools, only on success), or intact JSON text. No fuzzy extraction.
    const source = resolveStructuredSource(result);
    if (!source || source.value === null || typeof source.value !== "object") {
      return { matched: false, reason: `Field '${condition.field}' not found (result is not structured JSON)` };
    }

    const sourceObj = source.value;
    canonicalJson(sourceObj);
    const value = getNestedField(sourceObj, condition.field);
    if (value === undefined) {
      return { matched: false, reason: `Field '${condition.field}' not present in result` };
    }

    // Evaluate operators
    if (condition.equals !== undefined) {
      if (deepEquals(value, condition.equals)) {
        return { matched: true, reason: `Field '${condition.field}' equals ${JSON.stringify(condition.equals)}` };
      }
      return { matched: false, reason: `Field '${condition.field}' is ${JSON.stringify(value)}, expected ${JSON.stringify(condition.equals)}` };
    }

    if (condition.notEquals !== undefined) {
      if (!deepEquals(value, condition.notEquals)) {
        return { matched: true, reason: `Field '${condition.field}' not equals ${JSON.stringify(condition.notEquals)}` };
      }
      return { matched: false, reason: `Field '${condition.field}' is equal to ${JSON.stringify(condition.notEquals)}` };
    }

    if (Array.isArray(condition.in)) {
      const found = condition.in.some(target => deepEquals(value, target));
      if (found) {
        return { matched: true, reason: `Field '${condition.field}' is in [${condition.in.map(x => JSON.stringify(x)).join(", ")}]` };
      }
      return { matched: false, reason: `Field '${condition.field}' (${JSON.stringify(value)}) not in expected list` };
    }

    if (condition.greaterThan !== undefined) {
      if (typeof value === "number" && value > condition.greaterThan) {
        return { matched: true, reason: `Field '${condition.field}' (${value}) > ${condition.greaterThan}` };
      }
      return { matched: false, reason: `Field '${condition.field}' (${value}) not > ${condition.greaterThan}` };
    }

    if (condition.greaterThanOrEqual !== undefined) {
      if (typeof value === "number" && value >= condition.greaterThanOrEqual) {
        return { matched: true, reason: `Field '${condition.field}' (${value}) >= ${condition.greaterThanOrEqual}` };
      }
      return { matched: false, reason: `Field '${condition.field}' (${value}) not >= ${condition.greaterThanOrEqual}` };
    }

    if (condition.lessThan !== undefined) {
      if (typeof value === "number" && value < condition.lessThan) {
        return { matched: true, reason: `Field '${condition.field}' (${value}) < ${condition.lessThan}` };
      }
      return { matched: false, reason: `Field '${condition.field}' (${value}) not < ${condition.lessThan}` };
    }

    if (condition.lessThanOrEqual !== undefined) {
      if (typeof value === "number" && value <= condition.lessThanOrEqual) {
        return { matched: true, reason: `Field '${condition.field}' (${value}) <= ${condition.lessThanOrEqual}` };
      }
      return { matched: false, reason: `Field '${condition.field}' (${value}) not <= ${condition.lessThanOrEqual}` };
    }

    if (condition.contains !== undefined) {
      if (typeof value === "string" && matchesTextMarker(value, condition.contains)) {
        return { matched: true, reason: `Field '${condition.field}' contains '${condition.contains}'` };
      }
      return { matched: false, reason: `Field '${condition.field}' does not contain '${condition.contains}'` };
    }

    return { matched: false, reason: "No valid operator matched for field condition" };
  }

  // 2. Text contains condition
  if ("textContains" in condition) {
    if (matchesTextMarker(safeContent, condition.textContains)) {
      return { matched: true, reason: `Content contains '${condition.textContains}' (negation-checked)` };
    }
    return { matched: false, reason: `Content does not contain marker '${condition.textContains}'` };
  }

  // 3. Text regex match condition
  if ("textMatches" in condition) {
    try {
      const reg = RE2JS.compile(condition.textMatches);
      if (reg.test(safeContent)) {
        return { matched: true, reason: `Content matches regex /${condition.textMatches}/` };
      }
      return { matched: false, reason: `Content did not match regex /${condition.textMatches}/` };
    } catch (e) {
      return { matched: false, reason: `Invalid regular expression: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // 4. Result SHA256 match condition
  if ("resultSha256" in condition) {
    const hash = computeSha256(result.structuredContent ?? safeContent);
    if (hash === condition.resultSha256) {
      return { matched: true, reason: `Result SHA256 matches ${condition.resultSha256}` };
    }
    return { matched: false, reason: `Result SHA256 ${hash} does not match ${condition.resultSha256}` };
  }

  return { matched: false, reason: "Unsupported condition format" };
}

/** Maximum length of the bounded observed-value string shown in the UI. */
export const MAX_OBSERVED_VALUE_LENGTH = 80;

/** Maximum length of the bounded field label shown in the UI. */
export const MAX_OBSERVED_FIELD_LENGTH = 60;

/** Maximum length of a condition field path. */
export const MAX_CONDITION_FIELD_LENGTH = 256;

const SENSITIVE_WORDS = new Set([
  "key", "keys", "token", "tokens", "secret", "secrets", "password", "passwd", "pass",
  "auth", "authorization", "credential", "credentials", "apikey", "apisecret", "accesskey", "privatekey",
]);

function isSensitiveField(path: string): boolean {
  const segments = path.replace(/\[(\w+)\]/g, ".$1").split(".").filter(Boolean);
  const words = segments.flatMap(segment =>
    segment
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[^A-Za-z0-9]+/g, " ")
      .toLowerCase()
      .split(" ")
      .filter(Boolean)
  );
  return words.some(word => SENSITIVE_WORDS.has(word));
}

/**
 * Renders only a scalar value for UI display. Composite values are collapsed to
 * a placeholder so no nested object contents (which may include secrets the
 * field-path heuristic does not recognize) are ever rendered.
 */
function compactValueString(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[array: ${value.length}]`;
  switch (typeof value) {
    case "string":
      return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "object":
      return "[object]";
    default:
      return `[${typeof value}]`;
  }
}

/**
 * Extracts a concise, bounded, redacted observation of the condition's relevant
 * field for UI health display. Returns undefined when the condition has no
 * single relevant field (text/regex/hash conditions) or no structured value.
 * Never exposes the whole result.
 */
export function observeConditionValue(
  condition: MonitorCondition,
  result: { isError: boolean; content: string; structuredContent?: unknown; toolName?: string },
): ObservedValue | undefined {
  if (result.isError || !("field" in condition)) return undefined;

  const source = resolveStructuredSource(result);
  if (!source || source.value === null || typeof source.value !== "object") return undefined;

  const value = getNestedField(source.value, condition.field);
  if (value === undefined) return undefined;

  const redacted = isSensitiveField(condition.field);
  const rendered = redacted ? "[REDACTED]" : compactValueString(value);
  const bounded = Array.from(rendered).slice(0, MAX_OBSERVED_VALUE_LENGTH).join("");
  const fieldLabel = Array.from(condition.field.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")).slice(0, MAX_OBSERVED_FIELD_LENGTH).join("");

  return {
    field: condition.field.length > MAX_OBSERVED_FIELD_LENGTH ? fieldLabel + "…" : fieldLabel,
    value: rendered.length > MAX_OBSERVED_VALUE_LENGTH ? bounded + "…" : bounded,
    matched: false,
  };
}
