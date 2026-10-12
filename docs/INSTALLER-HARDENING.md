# Installer hardening notes

These are implementation requirements for the maintainers; they are not a patch automatically applied to the upstream code.

## Required behavior before any user-profile write

`runInstall()` should have a clear preflight phase and a separate mutation phase. The preflight phase should:

1. Check that required project files exist and the platform has a supported RTK asset or a compatible RTK already installed.
2. Validate any existing `hooks.json` and `mcp_config.json`. If an existing file is malformed, stop and preserve its bytes; do not replace it with an empty object.
3. Determine whether the existing RTK version is within the declared supported range.
4. Verify any downloaded RTK asset's checksum/signature before extraction.
5. Produce a plan/status result without writing when `--check` is requested.

Only after successful validation should install make backups and apply changes. If RTK is mandatory, provisioning or verification failure must abort before config mutation. Any intentionally supported degraded mode should require an explicit flag and produce a partial/unhealthy status.

## Two essential regression tests

The supplied black-box templates in `templates/tests/` are designed to fail on the current risky paths:

- `test-check-only-readonly.mjs`: runs `--check` with a clean temporary home and a fake RTK on PATH, then asserts the profile and copied source tree remain unmodified.
- `test-malformed-config-preservation.mjs`: gives the installer malformed `hooks.json` plus an unrelated MCP server, runs install in an isolated copy, then asserts install failed before changing either file or creating the plugin.

Copy them into `tests/`, add them to the end of `package.json`'s `test` chain, and update the README count/list. These are black-box tests; adapt their fixture assumptions if the installer gains an explicit config-root override, but retain the same safety assertions.

## UX recommendation

Add an explicit `--dry-run` or make `--check` meet the stronger no-write contract above. Print the exact target paths that would be changed, explain whether the plugin will be linked or copied, identify the pinned RTK version and the required network access, and ask for confirmation before writing in interactive installs. Use a separate explicit `--yes` flag for automation rather than silently bypassing confirmation.
