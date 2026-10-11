# pi-monitor

English | [简体中文](README.zh-CN.md)

Nonblocking, bounded background monitoring for Pi Coding Agent. Start a trusted read-only query, receive a monitor ID immediately, and resume the session when a condition is stably matched, a query fails, or the deadline expires.

![Background monitoring flow](docs/monitor-flow.svg)

**Pi-Web is supported, but not required.** The extension uses Pi host APIs rather than a web-specific backend. Compatible terminal hosts can display the same compact status widget; background queries also work without a UI.

## Install

```sh
pi install git:github.com/carrotciallo/pi-monitor
```

Run `/reload` in an existing session. Node.js 22.19 or newer is required. The host must provide `ExtensionToolContext.executeTool`, `before_agent_start.systemPromptOptions.promptGuidelines`, and the standard extension messaging API. Older Pi hosts lacking these APIs are not supported; Pi-Web alone does not supply missing SDK capabilities.

## Tools and Commands

| Tool | Purpose |
| --- | --- |
| `monitor_start` | Start bounded polling of a trusted read-only tool. |
| `monitor_status` | Read current-session monitor details and retained results. |
| `monitor_cancel` | Stop one monitor, or all current-session monitors. |

User commands: `/monitor_status [monitorId]` and `/monitor_cancel [monitorId | all]`.

A typical tool argument object:

```json
{
  "tool": "job_status",
  "args": { "id": "example-job" },
  "condition": { "field": "status", "equals": "completed" },
  "consecutiveMatches": 2,
  "description": "Wait for job completion"
}
```

Waiting hours for a structured value that must stay stable. Prefer a query that
prints one JSON document (for example a status tool with `--json`) over parsing
incidental shell text:

```json
{
  "tool": "bash",
  "args": { "command": "job-status --json" },
  "condition": { "field": "state", "equals": "drained" },
  "intervalSeconds": 30,
  "timeoutSeconds": 21600,
  "consecutiveMatches": 3,
  "stableForSeconds": 120,
  "description": "Wait for drain to hold for two minutes"
}
```

The command above is illustrative and is not executed here. A `bash` or
`hypa_shell` result is adapted for field conditions only when it is exactly JSON
(or a successful `output` that is exactly JSON); the example assumes
`job-status --json` prints a single compact JSON document with a `state` field.

`job_status` is illustrative: the named tool must exist and pass the tool policy. `bash` and `hypa_shell` also accept any nonempty `command`, including pipelines and scripts. Other writes, generic gateways and mutating tools remain blocked. Shell commands are not inspected: the query-only rule is a prompt constraint, not enforcement.

## Behavior

When a task is still pending and needs a later status check, the agent uses `monitor_start` instead of polling again. After the monitor starts, it stops direct checks of the same status and continues independent work, or ends the turn to await notification. One-shot operations do not need a monitor.

The system guideline and tool descriptions are concise, English and domain-neutral. The guideline defines when to monitor and how to yield; tool descriptions define arguments and results.

- Defaults: 5-second interval, 120-second timeout, and 3 retries after query errors. Maximum 5 concurrent monitors per session; queries for a monitor never overlap.
- Intervals: 2–300 seconds. Timeouts: 5–604800 seconds (up to seven days). Retries: 0–10.
- Stability: `consecutiveMatches` (1–1000, default 1) and `stableForSeconds` (0–604800, default 0). The monitor completes only when the condition holds for the required number of consecutive observed samples and for at least the required duration. A miss or a query error resets the progress; only observed samples count.
- Deduplication: starting a monitor with the same session, tool, canonical-JSON arguments, condition and full polling/stability configuration returns the existing running monitor with `reused: true` instead of creating a duplicate. The `description` label does not affect identity.
- Conditions: one field comparison, negation-aware text substring, RE2JS regular expression, or normalized-result SHA-256. Field comparisons include equality, membership and numeric bounds.
- Structured fields read host `structuredContent`; for `bash` and `hypa_shell` only, a successful result (`exit_code` 0) whose `output` is JSON is unwrapped, and text that is entirely JSON is accepted. Truncated, timed-out, killed or failed shell output is rejected, never partially parsed. There is no fuzzy or substring JSON extraction.
- Prefer structured fields for completion. Text negation detection is heuristic; RE2JS excludes lookaround and backreferences. Errors never count as matches.
- UI: status, short task label, query count and elapsed time, plus concise health (match progress, stability progress, last-success age, retry count, next check) and the relevant field value only. No cancel button. The latest terminal state remains briefly, then clears.
- Completion, query failure and timeout send a concise English status notification and resume the session. Raw responses and error details stay in `monitor_status`, not the notification. A condition match establishes only that condition; timeout or query failure does not establish failure of the underlying operation.
- Notifications are observations, not new instructions or authorization. The agent remains bound by the latest user request and existing permissions.
- Cancellation stops polling and suppresses late completion notifications. It does not cancel the underlying job.
- Lifecycle: a branch switch, session switch, reload or shutdown stops monitors as `interrupted`, which is distinct from an explicit user or agent `cancelled`. Interruption never sends a turn-waking notification, so it cannot wake the wrong branch or session. A concise resume notice is shown (or delivered as a non-turn-waking context message when there is no UI).

## Safety and Limits

Tool execution goes through the host permission and hook pipeline. Non-shell tools use a default-deny read-only policy, with selected built-in readers and suitably annotated query tools. `bash` and `hypa_shell` bypass this policy when a nonempty command is supplied, including when marked destructive; commands are passed unchanged to the host. Prompts instruct the agent to repeat status queries only, never task starts or mutations. This is not a command filter or sandbox: any side effect in a supplied command repeats on each check. Existing host permissions still apply.

A scoped, one-use call lease supports compatible external repeat guards. An external guard must understand these leases or otherwise allow bounded background queries; this repository does not install or disable a guard. In-process malicious extensions are outside the isolation boundary.

Monitor execution state is in memory, not durable across reloads or restarts. To avoid a silent disappearance, each monitor also writes a bounded, non-context lifecycle entry (start, terminal state, interruption) that never contains raw tool arguments or results. On load the active branch is read once: a running descriptor with no live monitor is reported as lost, and an interrupted descriptor is reported as a resume notice. Reconstruction is read-only and never resumes execution; descriptors written on a branch that is no longer active are not visible. Retained history is capped at 10 records per session; result text is truncated. Redaction is defense in depth, not a guarantee that arbitrary tool output contains no secrets. Do not monitor tools returning sensitive material. Descriptions are user-supplied labels and are not translated.

## Development

```sh
npm ci --include=dev
npm run check
npm test
npm pack --dry-run
```

CI runs on Node.js 22 and 24. External guard integration tests are skipped unless `PI_MONITOR_GUARD_PATH` points to a compatible guard extension. `PI_MONITOR_SECOND_SDK_ROOT` optionally adds a second installed SDK to those integration tests. Skipped integration tests are reported explicitly; they are not evidence of host compatibility.

Issues and pull requests are welcome. See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [MIT License](LICENSE).
