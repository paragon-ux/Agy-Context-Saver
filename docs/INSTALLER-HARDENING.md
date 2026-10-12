# Installer hardening policy

 This document summarizes the enforced installer safety contracts and regression verification suites in `Agy-Context-Saver`.

## Enforced behavior before any user-profile write

`runInstall()` in `scripts/install-register.mjs` and the Windows wrapper `install.ps1` enforce a strict preflight phase before mutating any user configuration:

1. **Read-only configuration validation (`parseAndValidateJsonConfig`)**: Existing `hooks.json` and `mcp_config.json` files are parsed and verified to be non-null JSON objects (and `mcpServers`, if present, must be a JSON object) **before** `--check` returns or any disk writes occur. Malformed or non-object JSON immediately aborts installation and preserves the user's original file bytes unchanged.
2. **Strict read-only `--check` and `--status`**: When `--check` (`-c`), `--status`, or `--help` is passed, zero files or directories are created and zero network calls are made. Conflicting flags (such as `--check --restore-backups` or `--check --uninstall`) are explicitly rejected with a non-zero exit code.
3. **RTK version & SHA-256 supply-chain verification**: `findExistingRtk()` validates that any local or `PATH` RTK binary satisfies `[>=0.50.0 <0.52.0]`. Downloaded RTK archives are verified against pinned SHA-256 digests (`RTK_CHECKSUMS`) before disk extraction.
4. **Fail-closed provisioning**: If RTK provisioning fails, installation aborts before touching `hooks.json`, `mcp_config.json`, plugin links, or `node.cmd` (unless `--allow-degraded` is explicitly passed).
5. **Windows `node.cmd` wrapper safety**: `install.ps1` executes `scripts/install-register.mjs` first and only writes `node.cmd` after registration succeeds with exit code `0` in install mode, backing up any pre-existing unmanaged `node.cmd` to `node.cmd.bak` and delegating non-governor calls to `node.exe`.

## Regression test coverage

The automated test suite (`npm test`) verifies these contracts across isolated `AGY_TEST_PROFILE_DIR` sandboxes:

- `tests/test-check-only-readonly.mjs`: Verifies `--check` on a clean temporary home leaves the profile and source tree untouched, fails closed on malformed existing config without writing, and rejects conflicting `--check --restore-backups` flags.
- `tests/test-malformed-config-preservation.mjs`: Verifies malformed `hooks.json` and non-object JSON shapes abort installation before modifying `hooks.json`, `mcp_config.json`, or `node.cmd`.
- `tests/test-lifecycle-rollback.mjs`: Verifies foreign hook/MCP preservation, backup creation/restoration, upgrade idempotency, incompatible `PATH` RTK rejection, and symlink/junction fallback to directory copy.
