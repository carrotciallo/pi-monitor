import { isAllowedShellQuery } from "./shell-policy.ts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { validateCondition } from "./matcher.ts";
import type { MonitorScheduler } from "./scheduler.ts";
import {
  MAX_CONTENT_LENGTH,
  type MonitorCondition,
  type MonitorRecord,
} from "./types.ts";

const FORBIDDEN_EXACT = new Set([
  "mcp",
  "mcpScript",
  "bash",
  "shell",
  "hypa_shell",
  "exec",
  "powershell",
  "terminal",
  "sh",
  "zsh",
  "agent_wait_policy",
]);

const KNOWN_READ_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "hypa_read",
  "hypa_grep",
  "hypa_find",
  "hypa_ls",
  "hypa_symbol",
  "hypa_outline",
]);

export function isAllowedMonitorTool(
  toolName: string,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
  args?: Record<string, unknown>
): boolean {
  if (!toolName || typeof toolName !== "string") {
    return false;
  }

  if (toolName === "bash" || toolName === "hypa_shell") {
    return args !== undefined && isAllowedShellQuery(args);
  }

  // 1. Exact forbidden tools
  if (FORBIDDEN_EXACT.has(toolName)) {
    return false;
  }

  // 2. Disallow self-monitoring and mcp generic gateways
  if (
    toolName.startsWith("monitor_") ||
    toolName === "agent_wait_policy" ||
    toolName.startsWith("mcp_") ||
    toolName.startsWith("mcpScript_")
  ) {
    return false;
  }

  // 3. Disallow explicitly destructive tools
  if (annotations?.destructiveHint === true) {
    return false;
  }

  // 4. Disallow mutating/dangerous verbs (delimited by _, ., -, or boundaries)
  if (
    /(?:^|[._-])(?:write|edit|patch|replace|delete|remove|rm|kill|cancel|restart|deploy|create|update|modify|print|ast_grep_replace)(?:$|[._-])/i.test(
      toolName
    ) ||
    /(?:^|[._-])set_/i.test(toolName) ||
    /print_3mf/i.test(toolName)
  ) {
    return false;
  }

  // 5. Whitelist known safe read tools
  if (KNOWN_READ_TOOLS.has(toolName)) {
    return true;
  }

  // 6. Explicit read-only annotations with query-like naming
  if (
    annotations?.readOnlyHint === true &&
    /(?:status|query|inspect|get|fetch|list|info)/i.test(toolName)
  ) {
    return true;
  }

  // Default-Deny: Reject all other unknown or unverified tools
  return false;
}

export function sanitizeValue(key: string, val: unknown): unknown {
  if (
    /^(?:.*[._-])?(?:key|token|secret|password|auth|authorization|credential|api_key|apikey|pass)(?:[._-].*)?$/i.test(
      key
    )
  ) {
    return "[REDACTED]";
  }
  if (Array.isArray(val)) {
    return val.map((item, idx) => sanitizeValue(String(idx), item));
  }
  if (val !== null && typeof val === "object") {
    return Object.fromEntries(
      Object.entries(val).map(([k, v]) => [k, sanitizeValue(k, v)])
    );
  }
  return val;
}

export function cleanControlCharacters(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function sanitizeRecord(record: MonitorRecord): Record<string, unknown> {
  const safeArgs = sanitizeValue("args", record.args) as Record<string, unknown>;
  let safeLastResult = record.lastResult;
  if (record.lastResult) {
    const cleanContent = cleanControlCharacters(record.lastResult.content ?? "");
    const truncatedContent =
      cleanContent.length > MAX_CONTENT_LENGTH
        ? cleanContent.slice(0, MAX_CONTENT_LENGTH) + " ...[truncated]"
        : cleanContent;
    safeLastResult = {
      ...record.lastResult,
      content: truncatedContent,
      structuredContent: sanitizeValue("structuredContent", record.lastResult.structuredContent),
      errorText: record.lastResult.errorText ? cleanControlCharacters(record.lastResult.errorText) : undefined,
    };
  }
  const safeRecord: Record<string, unknown> = {
    ...record,
    args: safeArgs,
    lastResult: safeLastResult,
  };
  // Health text is bounded and redacted at capture time; still clean control chars.
  if (safeRecord.lastErrorText) {
    safeRecord.lastErrorText = cleanControlCharacters(String(safeRecord.lastErrorText)).slice(0, 200);
  }
  return safeRecord;
}

export function registerMonitorTools(pi: ExtensionAPI, scheduler: MonitorScheduler) {
  const ConditionSchema = Type.Union([
    Type.Object({
      field: Type.String({ minLength: 1, maxLength: 256, description: "Dot-separated result field path, e.g. data.state" }),
      equals: Type.Optional(Type.Unknown({ description: "Value the field must equal" })),
      notEquals: Type.Optional(Type.Unknown({ description: "Value the field must not equal" })),
      in: Type.Optional(Type.Array(Type.Unknown(), { description: "Field must be one of these values" })),
      greaterThan: Type.Optional(Type.Number({ description: "Numeric value greater than" })),
      lessThan: Type.Optional(Type.Number({ description: "Numeric value less than" })),
      greaterThanOrEqual: Type.Optional(Type.Number({ description: "Numeric value greater than or equal" })),
      lessThanOrEqual: Type.Optional(Type.Number({ description: "Numeric value less than or equal" })),
      contains: Type.Optional(Type.String({ description: "Text field contains the given substring" })),
    }),
    Type.Object({
      textContains: Type.String({ minLength: 1, maxLength: 300, description: "Negation-aware substring match" }),
    }),
    Type.Object({
      textMatches: Type.String({ minLength: 1, maxLength: 200, description: "Regular expression to match" }),
    }),
    Type.Object({
      resultSha256: Type.String({ pattern: "^[a-f0-9]{64}$", description: "Expected SHA256 hash of the normalized result" }),
    }),
  ]);

  // 1. monitor_start
  pi.registerTool(defineTool({
    name: "monitor_start",
    label: "Start background monitor",
    description: "Default for waiting on pending tasks: poll a trusted read-only tool or shell query in the background. Returns immediately; a match, query failure or timeout resumes the session. Shell: status queries only, never task starts or mutations.",
    parameters: Type.Object({
      tool: Type.String({ description: "Query tool name; bash/hypa_shell accept any command without command-level filtering" }),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Argument object passed to the tool; defaults to {}" })),
      condition: ConditionSchema,
      intervalSeconds: Type.Optional(Type.Number({ minimum: 2, maximum: 300, description: "Background polling interval in seconds (default 5)" })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 5, maximum: 604800, description: "Maximum monitoring timeout in seconds (default 120, maximum 604800 = 7 days)" })),
      maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Backoff retries on transient execution errors (default 3)" })),
      consecutiveMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Require this many consecutive matching samples before completing (default 1)" })),
      stableForSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 604800, description: "Require the condition to stay matched this long before completing (default 0)" })),
      description: Type.Optional(Type.String({ maxLength: 100, description: "Short task label" })),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionToolContext) {
      const allTools = pi.getAllTools();
      const targetTool = allTools.find(t => t.name === params.tool);
      if (!targetTool) {
        return {
          content: [{ type: "text", text: `Cannot start monitor: tool '${params.tool}' not found` }],
          details: { error: `Tool '${params.tool}' not found` },
          isError: true,
        };
      }

      if (!isAllowedMonitorTool(params.tool, targetTool.annotations, params.args ?? {})) {
        return {
          content: [{ type: "text", text: `Cannot start monitor: '${params.tool}' requires a nonempty command (bash/hypa_shell) or trusted read-only eligibility; it cannot be used for background monitoring with these arguments` }],
          details: { error: `Tool '${params.tool}' is not permitted for background monitoring` },
          isError: true,
        };
      }

      try {
        validateCondition(params.condition as MonitorCondition);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Cannot start monitor: invalid condition: ${errorMsg}` }],
          details: { error: errorMsg },
          isError: true,
        };
      }

      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const { record, reused } = scheduler.startOrReuseMonitor(
          sessionId,
          params.tool,
          params.args ?? {},
          params.condition as MonitorCondition,
          {
            intervalSeconds: params.intervalSeconds,
            timeoutSeconds: params.timeoutSeconds,
            maxRetries: params.maxRetries,
            consecutiveMatches: params.consecutiveMatches,
            stableForSeconds: params.stableForSeconds,
            description: params.description,
          },
          ctx
        );

        const responseText = JSON.stringify({
          started: true,
          reused,
          monitorId: record.id,
          status: record.status,
          tool: record.tool,
          intervalSeconds: record.options.intervalSeconds,
          timeoutSeconds: record.options.timeoutSeconds,
          consecutiveMatches: record.options.consecutiveMatches,
          stableForSeconds: record.options.stableForSeconds,
          description: record.options.description,
          message: reused
            ? "An identical running monitor already exists; returning it instead of starting a duplicate."
            : "Background monitor started. A terminal notification will resume the session when it finishes.",
        }, null, 2);

        return {
          content: [{ type: "text", text: responseText }],
          details: { recordId: record.id, status: record.status, reused },
        };
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to start background monitor: ${errorMsg}` }],
          details: { error: errorMsg },
          isError: true,
        };
      }
    },
  }));

  // 2. monitor_status
  pi.registerTool(defineTool({
    name: "monitor_status",
    label: "Check monitor status",
    description: "View details of running or recently completed background monitors in the current session.",
    parameters: Type.Object({
      monitorId: Type.Optional(Type.String({ description: "Specific monitorId to query; if omitted, returns all monitors in the current session" })),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionToolContext) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (params.monitorId) {
        const record = scheduler.getRecord(params.monitorId);
        if (!record || record.sessionId !== sessionId) {
          return {
            content: [{ type: "text", text: `Monitor '${params.monitorId}' not found` }],
            details: { error: "Monitor not found", monitorId: params.monitorId },
            isError: true,
          };
        }
        const safeRecord = sanitizeRecord(record);
        return {
          content: [{ type: "text", text: JSON.stringify(safeRecord, null, 2) }],
          details: safeRecord,
        };
      }

      const records = scheduler.getSessionRecords(sessionId);
      const safeRecords = records.map(sanitizeRecord);
      return {
        content: [{ type: "text", text: JSON.stringify(safeRecords, null, 2) }],
        details: { count: safeRecords.length, records: safeRecords },
      };
    },
  }));

  // 3. monitor_cancel
  pi.registerTool(defineTool({
    name: "monitor_cancel",
    label: "Cancel monitor",
    description: "Cancel a background monitor (or pass 'all' to cancel all running monitors in the current session).",
    parameters: Type.Object({
      monitorId: Type.String({ description: "monitorId to cancel, or 'all' to cancel all monitors in the current session" }),
      reason: Type.Optional(Type.String({ description: "Reason for cancellation" })),
    }),
    async execute(_id, params, _signal, _update, ctx: ExtensionToolContext) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (params.monitorId === "all") {
        const records = scheduler.getSessionRecords(sessionId);
        let cancelledCount = 0;
        for (const r of records) {
          if (r.status === "running") {
            scheduler.cancel(r.id, params.reason ?? "bulk cancel", sessionId);
            cancelledCount++;
          }
        }
        return {
          content: [{ type: "text", text: `Cancelled ${cancelledCount} running background monitors` }],
          details: { cancelledCount },
        };
      }

      const ok = scheduler.cancel(params.monitorId, params.reason ?? "cancelled by model", sessionId);
      if (!ok) {
        return {
          content: [{ type: "text", text: `Cannot cancel monitor '${params.monitorId}': it does not exist, does not belong to the current session, or is already terminal` }],
          details: { error: "Cannot cancel monitor", monitorId: params.monitorId },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Background monitor '${params.monitorId}' cancelled successfully` }],
        details: { monitorId: params.monitorId, cancelled: true },
      };
    },
  }));
}
