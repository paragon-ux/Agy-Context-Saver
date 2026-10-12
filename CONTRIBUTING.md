# Contributing

Issues and pull requests are welcome. For behavior-changing work, open an issue first so the proposed governance or installation impact can be discussed before code changes land.

## Development environment

- Use a currently maintained Node.js line. The release CI template tests Node 22 and 24 on Windows, macOS, and Linux.
- Runtime dependencies should remain zero unless there is a specific, reviewed reason to add one.
- Do not run the installer against your normal Antigravity profile while testing installer changes. Use a disposable home/config directory and an isolated source-tree copy.
- Never attach raw conversation transcripts, access tokens, or user config files to a public issue. Redact logs before sharing.

## Before submitting a pull request

Run the following in a clean checkout after applying your changes:

```bash
node scripts/release-preflight.mjs
npm test
npm pack --dry-run --json
git diff --check
```

The release preflight is intentionally read-only. It checks package metadata, npm file inclusion, consistency between the documented and executed test suites, and required policy files. It does not prove that Antigravity integration works on a live machine.

## Installer / hook changes

A pull request touching `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, hook rules, configuration serialization, or uninstall/restore behavior must include regression tests for:

- Fresh profile and existing profile behavior.
- Existing unrelated hook/MCP entries preserved without semantic or byte-level loss where promised.
- Malformed config files failing closed without being overwritten.
- Repeated install and upgrade idempotency.
- Failed or incompatible RTK provisioning not leaving a misleading “healthy” installation.
- Uninstall and backup restore in a disposable profile.
- Windows junction/symlink fallback as well as POSIX symlink behavior.

Tests should not depend on a maintainer's personal `~/.gemini` state, a developer-installed RTK binary, or interactive Antigravity sessions.

## Pull requests

- Explain the user-visible behavior change and compatibility impact.
- Include tests for regressions and edge cases.
- Update `README.md`, `docs/`, and `CHANGELOG.md` when behavior, configuration, platform support, or release process changes.
- Keep package version changes in release commits rather than feature PRs unless requested by maintainers.
- Do not claim a platform, RTK version, or Antigravity version is supported unless it has been tested or is clearly labelled experimental.

## Review and conduct

Contributors are expected to follow `CODE_OF_CONDUCT.md`. Maintainers may request revisions or close contributions that do not meet safety, correctness, or project-scope requirements.
