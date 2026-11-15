# pi-monitor trust

Background monitors require a live `readOnlyHint: true` declaration, a known
read-only builtin, or an explicit Allow rule. The documented shell exception
accepts arbitrary nonempty commands; only use it for read-only queries.
Cached MCP annotations do not grant access: flat name matches cannot prove
runtime ownership, schema identity or freshness. If the adapter drops live
annotations, explicitly Allow a tool only after verifying it is read-only.
Use `Deny` for tools you do not want the monitor to poll.

Copy this file to `~/.pi/agent/pi-monitor.md` and edit the lists below. For
rules that belong to one repository, put a `PI-MONITOR.md` at its root instead;
that file is read only when the project is trusted.

Only `-` list items under an `Allow` or `Deny` heading are rules. Every other
line, including these, is documentation. Keep the reasons next to the rules so
a later reader knows why each one is here.

Rules are globs matched case-insensitively: `*` matches any run of characters
and `?` matches exactly one.

    mail_list_*                 any tool whose name starts with mail_list_
    *status
    index_search
    server_read_*              a directly registered server read tool

An Allow entry cannot override the hard blocks: forbidden gateways (`mcp`,
`mcpScript`), MCP namespace proxies (`mcp__<server>`), tools that declare
`destructiveHint: true`, and tools whose names say they mutate something
(write, edit, delete, remove, create, update, set_, send, print, …). If a name
is rejected despite an Allow entry here, that is why.

A `Deny` entry takes precedence over every allow path, including `bash`,
`hypa_shell`, live read-only annotations and known read-only builtins.
Shell tools retain their documented exception to destructive metadata checks;
that exception never bypasses an explicit Deny.

## Allow

- `mail_list_*` — read-only mailbox listings; the mail server omits annotations on some builds
- `mail_get_attachment_content` — reads one attachment without changing state

## Deny

- `mail_get_emails_content` — clears the unread flag when `mark_as_read` is true
