# Contributing

Issues and pull requests are welcome. Include the Pi host and Node.js versions, expected behavior, actual behavior, and a minimal reproduction. Remove secrets and personal information from logs.

Before opening a pull request, run:

```sh
npm ci --include=dev
npm run check
npm test
npm pack --dry-run
```

Keep changes focused. Add regression coverage for behavioral changes, maintain default-deny enforcement for non-shell tools and the documented unrestricted shell exception, and keep plugin-authored prompts and messages concise, English and domain-neutral. Update both README languages when user-facing behavior changes.

Optional external-guard integration tests require `PI_MONITOR_GUARD_PATH`; an additional SDK can be supplied through `PI_MONITOR_SECOND_SDK_ROOT`. Do not commit local paths or credentials.

Contributions are licensed under the project's MIT license. Report vulnerabilities according to [SECURITY.md](SECURITY.md), not in a public issue.
