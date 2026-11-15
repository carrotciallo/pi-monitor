import { isSensitiveField } from "./matcher.ts";
import { MAX_CONTENT_LENGTH } from "./types.ts";

export type SanitizedValue = string | number | boolean | null | undefined | SanitizedValue[] | { [key: string]: SanitizedValue };

/** Bounded, getter-free projection for status output and retained samples. */
export function sanitizeValue(key: string, value: unknown): SanitizedValue {
  const ancestors = new Set<object>();
  let remaining = MAX_CONTENT_LENGTH;
  let nodes = 0;
  function visit(name: string, val: unknown, depth: number): SanitizedValue {
    if (isSensitiveField(name)) return "[REDACTED]";
    if (++nodes > 256 || depth > 16 || remaining <= 0) return "[TRUNCATED]";
    if (typeof val === "string") {
      const text = val.slice(0, remaining);
      remaining -= text.length;
      return text.length < val.length ? text + "[TRUNCATED]" : text;
    }
    if (val === null || val === undefined || typeof val === "boolean") return val;
    if (typeof val === "number") return Number.isFinite(val) ? val : "[NON-JSON]";
    if (typeof val !== "object") return "[NON-JSON]";
    if (ancestors.has(val)) return "[CIRCULAR]";
    ancestors.add(val);
    try {
      const entries: Array<[string, SanitizedValue]> = [];
      for (const name of Object.keys(val)) {
        if (nodes >= 256 || remaining <= 0) {
          entries.push(["__truncated__", "[TRUNCATED]"]);
          break;
        }
        remaining -= name.length;
        const descriptor = Object.getOwnPropertyDescriptor(val, name);
        entries.push([name.slice(0, MAX_CONTENT_LENGTH), descriptor && "value" in descriptor
          ? visit(name, descriptor.value, depth + 1) : "[ACCESSOR]"]);
      }
      return Array.isArray(val) ? entries.map(([, item]) => item) : Object.fromEntries(entries);
    } finally {
      ancestors.delete(val);
    }
  }
  return visit(key, value, 0);
}
