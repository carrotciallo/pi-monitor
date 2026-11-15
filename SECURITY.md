# Security Policy

Security fixes target the latest version on the default branch.

Use this repository's **Security → Report a vulnerability** form to report suspected vulnerabilities privately. Do not post credentials, personal data, exploit payloads or sensitive tool results in public issues. If private reporting is unavailable, open an issue requesting a private reporting channel without disclosing vulnerability details.

Include affected versions, impact and a minimal sanitized reproduction. Do not include real API keys or account tokens.

The extension does not sandbox other installed extensions or tools. `bash` and `hypa_shell` accept arbitrary nonempty commands, including tools marked destructive; query-only behavior is a prompt instruction, not command filtering. Commands may repeat side effects on every check. Explicit Deny rules apply to shell tools too. Host permissions and hooks still apply. Read-only annotations for other tools must come from trusted providers. Result redaction is not a guarantee that arbitrary output is safe to publish. Background status notifications do not authorize new actions.

Cached MCP annotations are diagnostic only. Without a verifiable runtime server/tool/schema binding they cannot grant polling permission; use live annotations or explicit trusted Allow rules instead.

New version-2 lifecycle entries contain an argument digest and fixed status classifications, not raw arguments, conditions, user descriptions or tool errors. Version-1 entries remain readable but may already contain raw arguments in `argsHash` and other sensitive fields. Upgrading does not rewrite historical session files. Review affected sessions locally using a trusted editor (including backups and exported copies), remove sensitive legacy entries where appropriate, and rotate credentials that were exposed outside their intended boundary. Do not paste session contents into public issues.

Runtime status still contains a bounded result preview; arbitrary free text cannot be reliably redacted. Terminal observations use a branch-local outbox containing IDs, tool name, status and check count, never arguments, descriptions or raw errors. `notified: true` means a matching custom-message entry was observed in the active session branch; it does not prove the user saw it or the model resumed. Cancelled/interrupted records have `notificationDelivery: "suppressed"` and `notified: false`.

Delivery waits for an idle session with no queued user messages, then appends a non-waking notification and verifies its session entry before requesting a separate wake. Busy sessions have no finite delivery deadline; `pending` remains visible rather than silently claiming success. The void host API cannot expose asynchronous send errors directly: missing notification entries become `delivery_unknown`; missing wake entries become `unconfirmed` after 30 seconds and emit a fixed diagnostic. A persisted wake marker still does not prove successful model completion.

Only unsent `pending` outbox entries are recovered on the active branch. Ambiguous submissions and wake requests are never automatically repeated. Use `/monitor-delivery` or `monitor_status` to distinguish delivery from wake state. Recovery does not replay legacy 1.4.0 notifications without an outbox receipt, and branch changes never deliver old pending observations into the new branch.
