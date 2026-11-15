# Pinned Pi integration fixes

These opt-in patches integrate pi-monitor with **billion-context 0.1.215** and
**pi-mcp-adapter 7.0.1**. They are maintained here, not published as upstream fixes.
Original npm packages are never edited. License files remain with each copy.

## Install

First configure this pi-monitor repository as a local Pi package. Install the two
exact upstream versions into Pi's managed npm directory. Then run:

```sh
node integrations/install.mjs              # prepare and verify local copies only
node integrations/install.mjs --activate   # replace the two package sources
```

`--agent-dir` and `--npm-root` override the default `~/.pi/agent` and its
`npm/node_modules`. The installer checks upstream versions and exact patch
preimages, creates content-addressed copies under `monitor-integrations`, and
records original/installed SHA-256 values in `monitor-integration.json`. It refuses
unknown versions or modified installed targets. Settings activation preserves all
other keys and package resource filters. It does not print settings, copy secrets,
restart services, or reload a live session. Reload Pi or start a fresh session to
use the installed copies. Running monitors are not resumed across reloads.

Copies resolve dependencies from the managed npm directory. Keep that dependency
installation available; after upgrading dependencies, rerun the integration tests
and installer. Package code updates require a reviewed new patch/version pin.

## Contracts

- `pi-monitor.call-authority.v2` grants independent claims to cooperating guards,
  bound to the active AsyncLocalStorage context, session, tool, canonical args,
  event ID, abort signal and 60-second issuance window. A forged parent ID grants
  nothing. In-process extensions remain trusted code, not a security sandbox.
- ACP does not mutate or warn on leased samples, or charge them to foreground
  repetition counters. Scheduler concurrency/deadline/interval limits still apply.
  Ordinary repetitive calls retain ACP protection. Policy refusals are terminal,
  not retried into a foreground abort.
- MCP concrete registrations are bound to host source path and schema. Current
  connected catalog metadata is checked, never name-only cached authorization.
  Generic gateways and script tools do not publish identities. Direct and deferred
  executions both retain structuredContent. Explicit trusted Allow remains needed
  when a concrete tool does not advertise readOnlyHint.
- `/monitor-errors` shows bounded nested-failure diagnostics. The separate log is
  `~/.pi/agent/usage/monitor-errors.jsonl` (1 MiB plus one rotated file, mode 0600).
  It contains IDs and fixed error categories, not tool arguments or raw output.

## Verify

```sh
PI_MONITOR_ACP_ROOT="$HOME/.pi/agent/npm/node_modules/billion-context" \
PI_MONITOR_MCP_ROOT="$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter" \
PI_MONITOR_GUARD_PATH="/path/to/recoverable-tool-guard/index.ts" \
PI_MONITOR_SECOND_SDK_ROOT="/path/to/host/pi-coding-agent" npm test
npm run check
```

Tests patch original upstream bundles in memory. Do not point these preimage tests
at already-patched copies. The guard is optional and must not be re-enabled just
for testing; the tests load it in an isolated process.

## Roll back

Change only the two integration package sources in Pi settings back to
`npm:billion-context@0.1.215` and `npm:pi-mcp-adapter@7.0.1`, then reload. This restores
upstream behavior, including its monitor compatibility limitations. Do not turn
off the foreground repeat guard globally as a workaround. Old v1 monitor entries
may contain sensitive values; installation never rewrites historical sessions.
