# pi-monitor

<p align="center">
  <img src="docs/promo-poster.png" alt="pi-monitor" width="100%" />
</p>

<p align="center">
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19.0-brightgreen.svg" alt="Node.js version" /></a>
  <a href="https://github.com/carrotciallo/pi-monitor/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
  <a href="https://github.com/carrotciallo/pi-monitor"><img src="https://img.shields.io/badge/Pi%20Coding%20Agent-Extension-purple.svg" alt="Pi Extension" /></a>
</p>

<p align="center">
  <b>English</b> | <b><a href="README.zh-CN.md">简体中文</a></b>
</p>

> **Nonblocking, bounded background monitoring for Pi Coding Agent.**  
> Start a trusted read-only query, receive a monitor ID immediately, and resume the session when a condition is stably matched, a query fails, or the deadline expires. Say goodbye to idle token-burning polling loops in your agent workflows.

---

## ⚡ Why pi-monitor?

When managing long-running background tasks (e.g. multi-step builds, long CI pipelines, server provisioning, database restores), standard AI Coding Agents fall into active polling traps:

| Dimension | Legacy Agent Polling ❌ | With pi-monitor ✅ |
| :--- | :--- | :--- |
| **Execution Model** | Burns turn cycles with repetitive `sleep` and status tools | Instantly yields control; nonblocking bounded background polling |
| **Token Consumption** | Repetitive status checks consume massive prompt context | Headless scheduler queries in background; **0 extra LLM tokens burned** |
| **Turn Lifecycle** | Blocks user interaction or triggers dead-loop safeguards | Agent continues independent tasks or ends turn cleanly awaiting wakeup |
| **Stability Validation** | Susceptible to transient flickers or single false positives | Dual debounce: `consecutiveMatches` and `stableForSeconds` |
| **Concurrency & Safety** | Risk of overlapping queries and ReDoS vulnerabilities | **Single in-flight lock**, RE2JS ReDoS immunity, and scoped call leases |

---

## Architecture Overview

**Pi-Web is supported, but not required.**  
The extension relies on native Pi host extension APIs rather than a web-only backend. Compatible terminal hosts display a compact live status widget; background queries and session resume work equally well in headless environments.

---

## Installation

```sh
pi install git:github.com/carrotciallo/pi-monitor
```

Run `/reload` in an existing session.  
*Requirements*: Node.js >= 22.19.0. The host must supply `ExtensionToolContext.executeTool`, `before_agent_start.systemPromptOptions.promptGuidelines`, and standard extension messaging APIs.

---

## Quick Start & Scenarios

### Tools and Commands

| Tool / Command | Type | Purpose |
| :--- | :--- | :--- |
| `monitor_start` | Agent Tool | Start bounded polling of a trusted read-only tool; returns `monitorId` immediately |
| `monitor_status` | Agent Tool | Inspect current-session monitor details, health metrics, and retained output |
| `monitor_cancel` | Agent Tool | Stop a specific monitor or all active monitors in the current session |
| `/monitor_status [id]` | User Command | CLI / Web command to view live monitor status |
| `/monitor_cancel [id\|all]` | User Command | CLI / Web command to terminate background monitors |

---

### Scenario 1: Waiting for a Build / CI Job Completion

The agent triggers an asynchronous job, starts monitoring, and yields immediately:

```json
{
  "tool": "job_status",
  "args": { "id": "build-release-1024" },
  "condition": { "field": "status", "equals": "completed" },
  "consecutiveMatches": 2,
  "description": "Wait for build release completion"
}
```

---

### Scenario 2: Service Drain Stability Hold

For state transitions that require prolonged stability (e.g. connection draining before shutdown):

```json
{
  "tool": "bash",
  "args": { "command": "job-status --json" },
  "condition": { "field": "state", "equals": "drained" },
  "intervalSeconds": 30,
  "timeoutSeconds": 21600,
  "consecutiveMatches": 3,
  "stableForSeconds": 120,
  "description": "Wait for drain to hold stable for two minutes"
}
```

> **Note**: For `bash` and `hypa_shell`, when execution succeeds (`exit_code: 0`) and the output is valid JSON, the output is automatically unwrapped for field evaluation. Only exact JSON is adapted—no partial or fuzzy parsing.

---

## Behavior & Robustness

When a task is pending and requires a later check, the agent calls `monitor_start` instead of executing a polling loop.

- **Defaults & Limits**:
  - Polling interval: 5s (range: 2–300s)
  - Timeout: 120s (range: 5–604,800s / up to 7 days)
  - Max retries: 3 on transient errors (range: 0–10)
  - Concurrency: Max 5 concurrent monitors per session.
  - **Single In-Flight Lock**: Queries for a given monitor never overlap.
- **Stability Engine**:
  - `consecutiveMatches` (1–1000, default 1): Requires N continuous observed matches.
  - `stableForSeconds` (0–604800, default 0): Requires condition to hold continuously for at least N seconds.
  - Any miss or query failure immediately resets stability counters to prevent premature completion.
- **Smart Deduplication**: Starting a monitor with the same tool, canonical-JSON arguments, condition, `display` declaration, and polling config reuses the existing active monitor and sets `reused: true`.
- **Matching Engine**: Supports structured field checks (equality, numeric comparison, array inclusion), negation-aware text matching, RE2JS regular expressions, or SHA-256 hashes. RE2JS eliminates ReDoS risks.
- **UI & Resumption**:
  - Displays live status badge, task name, query count, elapsed time, health progress, and observed values.
  - **Progress display** (`display`): Declare up to 4 result fields to project into the live widget, so a polled script can report progress — download percentage, item counts, transfer speed — without the user asking for a status check. Each entry names a field path plus an optional `label`, `total`, or `totalField`:

    ```jsonc
    {
      "tool": "read",
      "args": { "path": "/tmp/progress.json" },
      "condition": { "field": "status", "equals": "done" },
      "display": [
        { "field": "downloaded", "label": "progress", "totalField": "totalBytes" },
        { "field": "speed", "label": "speed" }
      ]
    }
    ```

    renders as `progress=530/1000 · speed=1.2MB/s`. `totalField` reads a sibling field and wins over a fixed `total`. Values are bounded to 80 characters, sensitive field paths (containing `key`, `token`, `secret`, `password`, …) render as `[REDACTED]`, and composite values collapse to `[object]` or `[array: N]`. A failed or field-less sample clears the segment rather than showing a stale reading. Omitting `display` leaves the widget exactly as it was.
  - On condition match, query failure, or timeout, a concise notification wakes the session. Raw response payloads stay in `monitor_status` to prevent context pollution.
- **Branch & Lifecycle Isolation**: Branch switches, session changes, reloads, or shutdowns transition active monitors to `interrupted` without firing turn-waking messages into improper sessions.

---

## Safety & Permissions

- **Default-Deny Read Policy**: Non-shell tools must be provably read-only. A tool is admitted when it is a known read-only builtin, or when it declares `readOnlyHint: true` itself. Anything unproven is rejected.
- **Annotations Survive the Adapter**: Some MCP adapters register a server's tools without forwarding its `annotations` payload, which would make an explicitly read-only tool look unproven. When that happens pi-monitor recovers the declaration from the adapter's on-disk cache. This is evidence only, never authority: it cannot lift a hard block below, and a cached `readOnlyHint: true` on a mutating tool name is still rejected.
- **Hard Blocks Outrank Everything**: Forbidden gateways (`mcp`, `mcpScript`), MCP namespace proxies (`mcp__*`), `destructiveHint: true`, and mutating tool names are rejected before any annotation or trust rule is consulted. A mislabelled `readOnlyHint` therefore cannot admit a destructive tool, and trusting a proxy cannot hand the monitor every tool behind it.
- **Shell Query Constraints**: `bash` and `hypa_shell` accept nonempty commands. System guidelines instruct the agent to execute only idempotent read-only status checks. Commands inherit the host's existing permission boundaries.
- **Call Leases**: Scoped, one-use call leases allow seamless compatibility with external repeat guards and loop protection extensions.
- **Memory-Only & Redaction**: Execution state lives in memory only. Retained audit logs are capped at 10 items per session with automated redaction of sensitive arguments.

### Trusting a tool your host cannot vouch for

Many MCP servers describe their tools loosely, or not at all, so the default deny keeps them out of reach. Rather than weakening the default for every tool, you can vouch for specific tools in a Markdown file, which keeps the justification next to the rule:

```markdown
# pi-monitor trust

## Allow
- `mail_list_*` — read-only listings; the server omits annotations
- index_search

## Deny
- mail_get_emails_content
```

- **User level**: `~/.pi/agent/pi-monitor.md`, always read. Set `PI_MONITOR_TRUST_FILE` to keep the rules elsewhere.
- **Project level**: `PI-MONITOR.md` at the project root, read **only** when the project is trusted, so an untrusted repository cannot grant itself monitoring access.
- Patterns are globs: `*` matches any run of characters, `?` exactly one; matching is case-insensitive.
- Only `-` list items under an `Allow`/`Deny` heading are rules. Everything else is documentation and is ignored, so the file can explain itself.
- An explicit `Deny` beats an annotation. An explicit `Allow` rescues an unannotated tool. Neither can override a hard block above.

A commented starting point lives at [`docs/trust-example.md`](docs/trust-example.md); copy it to `~/.pi/agent/pi-monitor.md` and edit the two lists.

The cache fallback reads `~/.pi/agent/mcp-cache.json`; set `PI_MONITOR_MCP_CACHE` to point elsewhere.

---

## Development

```sh
# Install development dependencies
npm ci --include=dev

# Type checking
npm run check

# Verify packaging integrity
npm pack --dry-run
```

---

## Contributing & License

Contributions, issues, and PRs are welcome!  
See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [MIT License](LICENSE).
