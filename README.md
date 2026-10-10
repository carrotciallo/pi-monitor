# pi-monitor

English | [简体中文](README.zh-CN.md)

Nonblocking, bounded background monitoring for Pi Coding Agent. Start a trusted read-only query, receive a monitor ID immediately, and resume the session when a condition matches, a query fails, or the deadline expires.

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
  "description": "Wait for job completion"
}
```

`job_status` is illustrative: the named tool must actually exist and pass the read-only policy. Shell commands, writes, generic gateways, and mutating tools cannot be monitored.

## Behavior

- Defaults: 5-second interval, 120-second timeout, and 3 retries after query errors. Maximum 5 concurrent monitors per session; queries for a monitor never overlap.
- Intervals: 2–300 seconds. Timeouts: 5–600 seconds. Retries: 0–10.
- Conditions: one field comparison, negation-aware text substring, RE2JS regular expression, or normalized-result SHA-256. Field comparisons include equality, membership and numeric bounds.
- Prefer structured fields for completion. Text negation detection is heuristic; RE2JS excludes lookaround and backreferences. Errors never count as matches.
- UI: status, short task label, query count and elapsed time. No cancel button. The latest terminal state remains briefly, then clears.
- Completion, query failure and timeout send a concise English status notification and resume the session. Raw responses and error details stay in `monitor_status`, not the notification. A condition match establishes only that condition; timeout or query failure does not establish failure of the underlying operation.
- Notifications are observations, not new instructions or authorization. The agent remains bound by the latest user request and existing permissions.
- Cancellation stops polling and suppresses late completion notifications. It does not cancel the underlying job. Branch changes, session switches and shutdown cancel monitors.

## Safety and Limits

Tool execution goes through the host permission and hook pipeline. The read-only policy is default-deny, with selected built-in readers and suitably annotated query tools. Read-only annotations are a trust signal, not a sandbox; install only trusted tools and extensions.

A scoped, one-use call lease supports compatible external repeat guards. An external guard must understand these leases or otherwise allow bounded background queries; this repository does not install or disable a guard. In-process malicious extensions are outside the isolation boundary.

Monitor state is in memory, not durable across reloads or restarts. Retained history is capped at 10 records per session; result text is truncated. Redaction is defense in depth, not a guarantee that arbitrary tool output contains no secrets. Do not monitor tools returning sensitive material. Descriptions are user-supplied labels and are not translated.

## Development

```sh
npm ci --include=dev
npm run check
npm test
npm pack --dry-run
```

CI runs on Node.js 22 and 24. External guard integration tests are skipped unless `PI_MONITOR_GUARD_PATH` points to a compatible guard extension. `PI_MONITOR_SECOND_SDK_ROOT` optionally adds a second installed SDK to those integration tests. Skipped integration tests are reported explicitly; they are not evidence of host compatibility.

Issues and pull requests are welcome. See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md), and [MIT License](LICENSE).
