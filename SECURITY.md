# Security Policy

Security fixes target the latest version on the default branch.

Use this repository's **Security → Report a vulnerability** form to report suspected vulnerabilities privately. Do not post credentials, personal data, exploit payloads or sensitive tool results in public issues. If private reporting is unavailable, open an issue requesting a private reporting channel without disclosing vulnerability details.

Include affected versions, impact and a minimal sanitized reproduction. Do not include real API keys or account tokens.

The extension does not sandbox other installed extensions or tools. `bash` and `hypa_shell` accept arbitrary nonempty commands, including tools marked destructive; query-only behavior is a prompt instruction, not command filtering. Commands may repeat side effects on every check. Host permissions and hooks still apply. Read-only annotations for other tools must come from trusted providers. Result redaction is not a guarantee that arbitrary output is safe to publish. Background status notifications do not authorize new actions.
