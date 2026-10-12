# pi-monitor trust

Background monitors may only poll a tool that is provably read-only. A tool
proves it by declaring `readOnlyHint: true`. pi-monitor first reads that
declaration from the host; when an MCP adapter drops the annotations payload,
it recovers them from the adapter's cache (`~/.pi/agent/mcp-cache.json`) before
falling back to this file. Use this file for servers that declare nothing at
all, or to `Deny` a tool you do not want the monitor to poll.

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
    mcp__server__read_*         a specific tool on a specific MCP server

An Allow entry cannot override the hard blocks: forbidden gateways (`mcp`,
`mcpScript`), MCP namespace proxies (`mcp__<server>`), tools that declare
`destructiveHint: true`, and tools whose names say they mutate something
(write, edit, delete, remove, create, update, set_, send, print, …). If a name
is rejected despite an Allow entry here, that is why.

A `Deny` entry is the one rule that beats everything except those blocks: it
removes a tool that the server itself declared read-only, or that a known
read-only builtin list would otherwise admit.

## Allow

- `mail_list_*` — read-only mailbox listings; the mail server omits annotations on some builds
- `mail_get_attachment_content` — reads one attachment without changing state

## Deny

- `mail_get_emails_content` — clears the unread flag when `mark_as_read` is true
