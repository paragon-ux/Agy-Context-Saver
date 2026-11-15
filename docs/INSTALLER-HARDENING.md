# Installer hardening policy

This document summarizes the installer safety contracts, runtime self-protection boundaries, and regression verification suites in `Agy-Context-Saver`.

## Enforced behavior before any user-profile write

`runInstall()` in `scripts/install-register.mjs` and the Windows wrapper `install.ps1` run a preflight phase before mutating any user configuration:

1. **Read-only configuration validation (`parseAndValidateJsonConfig`)**: The installer parses existing `hooks.json`, `config.json`, and `mcp_config.json` files and verifies that each is a non-null JSON object (`mcpServers`, if present, must also be a JSON object) **before** `--check` returns or any disk writes occur. Malformed or non-object JSON aborts installation immediately and leaves the user's original file bytes unchanged.
2. **Strict read-only `--check` and `--status`**: Passing `--check` (`-c`), `--status`, or `--help` creates zero files or directories and makes zero network calls. Conflicting flags (`--check --restore-backups` or `--check --uninstall`) exit with a non-zero status code. `agy-context status` (`runStatus()`) reports all active integration layers, including `- Transcript Access Policy: OPEN (default)` or the active parent policy mode and owner (`DENY (owner: <convId>)` / `SELF-ONLY (owner: <convId>)`).
3. **RTK `>= 1.1.0` and SHA-256 supply-chain verification**: `findExistingRtk()` validates that any local or `PATH` RTK binary satisfies `>= 1.1.0`. Automated archive downloads fail closed unless pinned `RTK_CHECKSUMS` match before extraction.
4. **Fail-closed provisioning and MCP retirement**: If RTK provisioning fails, installation aborts before touching `hooks.json`, `mcp_config.json`, plugin links, CLI shims, or `node.cmd` (unless `--allow-degraded` is passed). On setup and uninstall, the installer prunes legacy `agy-context-saver*` keys and schema directories while leaving foreign MCP servers untouched.
5. **Windows `node.cmd` wrapper safety**: `install.ps1` runs `scripts/install-register.mjs` first and writes `node.cmd` only after registration exits with code `0` in install mode, backing up any unmanaged `node.cmd` to `node.cmd.bak` and delegating non-governor calls to `node.exe`.
6. **Child session lifecycle and governance file protection**: During active runs, `scripts/execution-guard-hook.mjs` blocks restricted child sessions (subagents and `/swarm` workers governed by `<stateDir>/transcript-access.json` or a `[agy-transcript-access: deny|self-only]` launch directive) from invoking lifecycle commands (`setup`, `install`, `uninstall`, `restore-backups`, `--setup`, `--install`, `--uninstall`, `--restore-backups`) or mutating `~/.gemini/config/plugins/agy-context-saver/`, `~/.gemini/config/scripts/execution-guard-hook.mjs`, `hooks.json`, `<stateDir>/transcript-access.json`, and repository governance files via file tools, shell redirects, in-place editors (`sed`, `perl`, `chmod`, `chown`, `ln`, `dd`, `patch`), or script interpreters.

## Regression test coverage

The automated test suite (`npm test`) verifies these contracts across isolated `AGY_TEST_PROFILE_DIR` sandboxes:

- `tests/test-check-only-readonly.mjs`: Verifies `--check` on a clean temporary home leaves the profile and source tree untouched, fails closed on malformed existing config without writing, and rejects conflicting `--check --restore-backups` flags.
- `tests/test-malformed-config-preservation.mjs`: Verifies malformed `hooks.json` and non-object JSON shapes abort installation before modifying `hooks.json`, `mcp_config.json`, or `node.cmd`.
- `tests/test-lifecycle-rollback.mjs`: Verifies foreign hook and MCP preservation, backup creation and restoration, upgrade idempotency, incompatible `PATH` RTK rejection, and symlink or junction fallback to directory copy.
- `tests/test-hook.mjs` and `tests/test-transcript.mjs`: Verify that restricted child sessions cannot execute lifecycle commands (`setup`, `install`, `uninstall`, `restore-backups`, `--install`, `--uninstall`, `--restore-backups`) or mutate installed plugin hooks, state files (`<stateDir>/transcript-access.json`), or governance scripts.
