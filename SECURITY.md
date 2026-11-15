# Security Policy

Security fixes target the latest version on the default branch.

Use this repository's **Security → Report a vulnerability** form to report suspected vulnerabilities privately. Do not post credentials, personal data, exploit payloads or sensitive tool results in public issues. If private reporting is unavailable, open an issue requesting a private reporting channel without disclosing vulnerability details.

Include affected versions, impact and a minimal sanitized reproduction. Do not include real API keys or account tokens.

The extension does not sandbox other installed extensions or tools. `bash` and `hypa_shell` accept arbitrary nonempty commands, including tools marked destructive; query-only behavior is a prompt instruction, not command filtering. Commands may repeat side effects on every check. Explicit Deny rules apply to shell tools too. Host permissions and hooks still apply. Read-only annotations for other tools must come from trusted providers. Result redaction is not a guarantee that arbitrary output is safe to publish. Background status notifications do not authorize new actions.

Cached MCP annotations are diagnostic only. Without a verifiable runtime server/tool/schema binding they cannot grant polling permission; use live annotations or explicit trusted Allow rules instead.

New version-2 lifecycle entries contain an argument digest and fixed status classifications, not raw arguments, conditions, user descriptions or tool errors. Version-1 entries remain readable but may already contain raw arguments in `argsHash` and other sensitive fields. Upgrading does not rewrite historical session files. Review affected sessions locally using a trusted editor (including backups and exported copies), remove sensitive legacy entries where appropriate, and rotate credentials that were exposed outside their intended boundary. Do not paste session contents into public issues.

Runtime status still contains a bounded result preview; arbitrary free text cannot be reliably redacted. A synchronous notification-send error leaves `notified: false` and a fixed `notificationError` diagnostic. The host API has no delivery acknowledgement, so an ambiguous send is not automatically retried: inspect `monitor_status` before taking further action.
