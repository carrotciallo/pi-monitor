export type FailureClass = "policy_denied" | "tool_unavailable" | "timeout" | "aborted" | "invalid_sample" | "tool_error";

/** Fixed classifications only; never return raw arguments or tool output. */
export function classifyFailure(text: string): FailureClass {
  if (/^\s*(?:\[ACP guardrail: (?:BLOCKED|REFUSED)|PI_MONITOR_POLICY_DENIED:|REPEAT_CALL_BLOCKED\b|NO_BUSINESS_PROGRESS\b)/.test(text)) return "policy_denied";
  if (/^Tool ['"]?[\w.-]+['"]? not found\b/.test(text)) return "tool_unavailable";
  if (/^Invalid monitor sample:/.test(text)) return "invalid_sample";
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/AbortError|aborted|cancelled/i.test(text)) return "aborted";
  return "tool_error";
}
