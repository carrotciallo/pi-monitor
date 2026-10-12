/**
 * Progress projection for the live widget.
 *
 * A polled script can report progress (download percentage, item counts) by
 * having `monitor_start` declare `display` specs. Each poll re-projects the
 * declared fields from the same result the condition is evaluated against, so
 * the user sees movement without asking for a status check.
 *
 * The projection is deliberately a thin read-only view over the existing
 * matcher helpers: `resolveStructuredSource` finds structured data and
 * `compactValueString` / `isSensitiveField` render and redact it. No new
 * rendering, parsing, or authorization path is introduced here, so a value that
 * is unsafe in the observed-value line is unsafe in exactly the same way.
 *
 * Specs name paths, never values. They are therefore static: safe to include in
 * a monitor's reuse identity, and never persisted alongside results.
 */

import {
  compactValueString,
  getNestedField,
  isSensitiveField,
  MAX_CONDITION_FIELD_LENGTH,
  MAX_OBSERVED_FIELD_LENGTH,
  MAX_OBSERVED_VALUE_LENGTH,
} from "./matcher.ts";
import { resolveStructuredSource, type ToolResultLike } from "./shell-json.ts";
import { MAX_DISPLAY_FIELDS, type DisplayFieldSpec, type DisplayValue } from "./types.ts";

/** Strips control characters and bounds a label for display. */
function boundedLabel(label: string): string {
  const cleaned = label.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length > MAX_OBSERVED_FIELD_LENGTH
    ? chars.slice(0, MAX_OBSERVED_FIELD_LENGTH).join("") + "…"
    : chars.join("");
}

/** Bounds a rendered value, matching the observed-value line's presentation. */
function boundedValue(rendered: string): string {
  const chars = Array.from(rendered);
  return chars.length > MAX_OBSERVED_VALUE_LENGTH
    ? chars.slice(0, MAX_OBSERVED_VALUE_LENGTH).join("") + "…"
    : chars.join("");
}

/**
 * Validates and normalizes declared display specs.
 *
 * Rejects a spec whose field path is empty or over-long, a non-finite `total`,
 * and a list longer than `MAX_DISPLAY_FIELDS`. Later duplicates of the same
 * label are dropped: the widget shows one line per label, so a second entry
 * could never render and would only make the reuse identity unstable.
 *
 * Throws with a caller-facing message; `monitor_start` reports it as a tool
 * error so a bad declaration fails loudly instead of silently showing nothing.
 */
export function normalizeDisplaySpecs(specs: unknown): DisplayFieldSpec[] | undefined {
  if (specs === undefined) return undefined;
  if (!Array.isArray(specs)) {
    throw new Error("display must be an array of { field, label?, total?, totalField? } objects");
  }
  if (specs.length > MAX_DISPLAY_FIELDS) {
    throw new Error(`display accepts at most ${MAX_DISPLAY_FIELDS} fields (received ${specs.length})`);
  }

  const normalized: DisplayFieldSpec[] = [];
  const seenLabels = new Set<string>();

  for (const raw of specs) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("each display entry must be an object with a 'field' string");
    }
    const spec = raw as Record<string, unknown>;
    const field = spec.field;
    if (typeof field !== "string" || field.trim() === "") {
      throw new Error("each display entry needs a nonempty 'field' string");
    }
    if (field.length > MAX_CONDITION_FIELD_LENGTH) {
      throw new Error(`display field '${field.slice(0, 32)}…' exceeds ${MAX_CONDITION_FIELD_LENGTH} characters`);
    }

    const totalField = spec.totalField;
    if (totalField !== undefined) {
      if (typeof totalField !== "string" || totalField.trim() === "") {
        throw new Error("display totalField must be a nonempty string");
      }
      if (totalField.length > MAX_CONDITION_FIELD_LENGTH) {
        throw new Error(`display totalField '${totalField.slice(0, 32)}…' exceeds ${MAX_CONDITION_FIELD_LENGTH} characters`);
      }
    }

    let total: number | undefined;
    if (spec.total !== undefined) {
      if (typeof spec.total !== "number" || !Number.isFinite(spec.total)) {
        throw new Error("display total must be a finite number");
      }
      total = spec.total;
    }

    const labelSource = typeof spec.label === "string" && spec.label.trim() !== "" ? spec.label : field;
    const label = boundedLabel(labelSource);
    if (!label) {
      throw new Error("each display entry needs a nonempty label");
    }
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);

    normalized.push({
      field,
      label,
      ...(total !== undefined ? { total } : {}),
      ...(totalField !== undefined ? { totalField } : {}),
    });
  }

  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Projects display values from one poll result.
 *
 * Returns undefined when there is nothing to show (no specs, a failed query, or
 * no structured value), which clears the widget segment rather than leaving a
 * stale reading. Composite values collapse to a placeholder and sensitive field
 * paths render as `[REDACTED]`, both inherited from the matcher helpers.
 */
export function observeDisplayValues(
  specs: DisplayFieldSpec[] | undefined,
  result: ToolResultLike
): DisplayValue[] | undefined {
  if (!specs || specs.length === 0) return undefined;
  if (result.isError) return undefined;

  const source = resolveStructuredSource(result);
  if (!source || source.value === null || typeof source.value !== "object") return undefined;

  const values: DisplayValue[] = [];
  for (const spec of specs) {
    const raw = getNestedField(source.value, spec.field);
    if (raw === undefined) continue;

    let rendered: string;
    if (isSensitiveField(spec.field)) {
      rendered = "[REDACTED]";
    } else {
      // A numeric count is the common progress shape; a composite collapses to
      // its placeholder exactly as the observed-value line does.
      rendered = compactValueString(raw) || "[value]";
    }

    // An optional total renders as `value/total`. `totalField` wins over a fixed
    // `total` so a spec can support both a default and a per-result override.
    let totalRendered: string | undefined;
    if (spec.totalField !== undefined) {
      const rawTotal = getNestedField(source.value, spec.totalField);
      if (rawTotal !== undefined && !isSensitiveField(spec.totalField)) {
        totalRendered = compactValueString(rawTotal) || undefined;
      }
    } else if (spec.total !== undefined) {
      totalRendered = String(spec.total);
    }

    values.push({
      label: spec.label ?? spec.field,
      value: boundedValue(rendered) + (totalRendered !== undefined ? `/${boundedValue(totalRendered)}` : ""),
    });
  }

  return values.length > 0 ? values : undefined;
}
