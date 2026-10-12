import { isAllowedShellQuery } from "./shell-policy.ts";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { validateCondition } from "./matcher.ts";
import { normalizeDisplaySpecs } from "./display.ts";
import { resolveToolAnnotations } from "./mcp-annotations.ts";
import {
  loadToolTrust,
  matchesToolPatterns,
  resolveProjectTrust,
  userTrustFilePath,
  type ToolTrust,
} from "./tool-trust.ts";
import type { MonitorScheduler } from "./scheduler.ts";
import {
  MAX_CONTENT_LENGTH,
  MAX_DISPLAY_FIELDS,
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

/**
 * Decides whether `monitor_start` may poll `toolName` in the background.
 *
 * Order matters. The hard blocks (forbidden gateways, explicit
 * `destructiveHint: true`, and mutating tool names) can never be overridden by
 * annotations or by a user trust file. User rules sit between those blocks and
 * the allow paths: an explicit Deny beats annotations, and an explicit Allow
 * rescues a tool that is otherwise only unproven.
 */
export function isAllowedMonitorTool(
  toolName: string,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
  args?: Record<string, unknown>,
  trust?: ToolTrust
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

  // 4. Disallow mutating/dangerous verbs (delimited by _, ., -, or boundaries).
  // These stay hard-coded so a mislabelled readOnlyHint cannot admit them.
  if (
    /(?:^|[._-])(?:write|edit|patch|replace|delete|remove|rm|kill|cancel|restart|deploy|create|update|modify|print|send|ast_grep_replace)(?:$|[._-])/i.test(
      toolName
    ) ||
    /(?:^|[._-])set_/i.test(toolName) ||
    /print_3mf/i.test(toolName)
  ) {
    return false;
  }

  // 5. Explicit user Deny, which beats every allow path below. Hard blocks
  // above already rejected their tools, so a Deny here is never the only
  // thing standing between the monitor and a destructive call.
  if (trust && matchesToolPatterns(toolName, trust.deny)) {
    return false;
  }

  // 6. Whitelist known safe read tools
  if (KNOWN_READ_TOOLS.has(toolName)) {
    return true;
  }

  // 7. An explicit read-only declaration is the strongest evidence a tool
  // offers; a server that says so is trusted without name heuristics.
  if (annotations?.readOnlyHint === true) {
    return true;
  }

  // 8. Explicit user Allow, for a tool the host cannot prove read-only.
  if (trust && matchesToolPatterns(toolName, trust.allow)) {
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
  // Display values are bounded and redacted at capture time; clean control
  // characters again so a status dump is safe in any host.
  if (Array.isArray(safeRecord.displayValues)) {
    safeRecord.displayValues = (safeRecord.displayValues as Array<{ label: string; value: string }>).map(v => ({
      label: cleanControlCharacters(String(v.label ?? "")),
      value: cleanControlCharacters(String(v.value ?? "")),
    }));
  }
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
      display: Type.Optional(Type.Array(Type.Object({
        field: Type.String({ minLength: 1, maxLength: 256, description: "Dot-separated result field path to show in the live widget, e.g. downloaded" }),
        label: Type.Optional(Type.String({ maxLength: 60, description: "Label shown instead of the field path" })),
        total: Type.Optional(Type.Number({ description: "Fixed total, rendering the value as value/total" })),
        totalField: Type.Optional(Type.String({ maxLength: 256, description: "Sibling field path holding the total, rendering as value/total" })),
      }), { maxItems: MAX_DISPLAY_FIELDS, description: `Up to ${MAX_DISPLAY_FIELDS} result fields projected into the live widget to show progress without a status check` })),
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

      const trust = loadToolTrust({
        cwd: ctx.cwd,
        projectTrusted: resolveProjectTrust(ctx),
      });

      // Pi drops MCP annotations on the direct path; recover the server's own
      // declaration from the adapter cache so a read-only tool is not denied as
      // unproven. This is evidence only: it cannot lift a hard block.
      const annotations = resolveToolAnnotations(params.tool, targetTool.annotations);

      if (!isAllowedMonitorTool(params.tool, annotations, params.args ?? {}, trust)) {
        const isShell = params.tool === "bash" || params.tool === "hypa_shell";
        const reason = isShell
          ? `'${params.tool}' needs a nonempty 'command' argument to poll.`
          : `'${params.tool}' is not a provably read-only tool.`;
        const hint = isShell
          ? "Pass { command: \"...\" } in args to select the query."
          : "The server declares no readOnlyHint for it. Allow it by name under an \"## Allow\" heading in " +
            `${trust.sources.length > 0 ? trust.sources.join(" or ") : userTrustFilePath()}.`;
        return {
          content: [{ type: "text", text: `Cannot start monitor: ${reason} It cannot be used for background monitoring with these arguments. ${hint}` }],
          details: { error: `Tool '${params.tool}' is not permitted for background monitoring`, hint },
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

      // Validate the display declaration up front so a bad spec fails loudly
      // instead of silently rendering nothing on every poll.
      let display;
      try {
        display = normalizeDisplaySpecs(params.display);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Cannot start monitor: invalid display: ${errorMsg}` }],
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
            display,
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
