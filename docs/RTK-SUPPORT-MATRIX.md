# RTK support and provisioning policy

## Current provisioner mapping

`scripts/provision-rtk.mjs` requires RTK `>= 1.1.0` (`MIN_RTK_VERSION = "1.1.0"`), prefers an already-installed compatible `rtk` binary on `PATH` before plugin-local directories, and verifies archive SHA-256 digests (`RTK_CHECKSUMS`) fail-closed during automated downloads when hashes are configured.

| Condition | Target Version / Source | Policy |
|---|---|---|
| Host `rtk` on `PATH` (`>= 1.1.0`) | System binary (`rtk hook antigravity`) | **Preferred.** Validated via `rtk --version`; no redundant binary download needed. |
| Plugin-local `bin/` (`>= 1.1.0`) | Provisioned local binary | Secondary fallback when host `PATH` lacks a compatible binary. |
| Incompatible (`< 1.1.0`) or missing `rtk` | Fail-closed preflight | Installer aborts cleanly with manual install instructions unless `--allow-degraded` is explicitly passed or verified checksums exist for the target platform. |

RTK release assets: <https://github.com/rtk-ai/rtk/releases/tag/v1.1.0>

## Enforced provisioning and compatibility policy

1. **Enforced minimum version (`>= 1.1.0`).** `findExistingRtk()` and `isCompatibleRtkVersion()` reject legacy `< 1.1.0` binaries across `PATH` and plugin-local directories because `rtk hook antigravity` native JSON rewriting is required.
2. **Hook delegation & compatibility guards.** `scripts/execution-guard-hook.mjs` delegates `run_command` rewriting via stdin JSON to `rtk hook antigravity`, guards absent host `rg` (`rtk grep` / unprefixed fallback), and reverts lossy implicit `wc`/`ls`/`diff` rewrites.
3. **Fail-closed SHA-256 verification.** `ensureRtkInstalled()` requires pinned `RTK_CHECKSUMS` for the target platform and aborts before extracting unverified archives.
4. **Fail-closed installer preflight.** `runInstall()` validates configuration syntax/shape (`hooks.json`, `mcp_config.json`) and checks RTK `>= 1.1.0` before mutating user profile configurations or creating shims/links. Provisioning failures abort installation unless `--allow-degraded` is explicitly specified.
5. **Manual installation fallback.** Install `rtk >= 1.1.0` onto `PATH` (e.g., via official upstream installer/Cargo/Homebrew) or pass `--allow-degraded` for hook-only governance without RTK rewriting.

## Release smoke tests

Run these checks before changing `MIN_RTK_VERSION` or `RTK_VERSION`:

- Exercise live `rtk >= 1.1.0 hook antigravity` compound commands, `bash -c` wrappers, and `agy-context transcript` passthrough via `node tests/test-rtk-integration.mjs`.
- Put a legacy `< 1.1.0` binary on `PATH` and verify `findExistingRtk()` and `execution-guard-hook.mjs` reject it safely.
- Exercise absent host `rg` and env-prefixed `rg`/`wc` commands in `node tests/test-hook.mjs`.
- Verify re-run/idempotency and uninstall/restore using a temporary `AGY_TEST_PROFILE_DIR` sandbox, never a developer's live profile.

## RTK Configuration Standardization & Default Modifications

To prevent diagnostic noise and promotional banners from polluting model context and command execution, `Agy-Context-Saver` standardizes upstream RTK configuration settings during installation (`scripts/provision-rtk.mjs` via `ensureRtkConfigured()`).

### Standardized Configuration Parameters

| Config File | Section | Parameter | Default Upstream Value | Agy-Context-Saver Standardized Value | Rationale & Forensic Justification |
|---|---|---|---|---|---|
| `%APPDATA%\rtk\config.toml` *(Win)*<br>`~/.config/rtk/config.toml` *(POSIX)* | `[hooks]` | `suppress_hook_warning` | `false` (or unconfigured) | `true` | **Context & Command Protection (RTK-01 / RTK-03)**:<br>Upstream RTK emits an unsolicited promotional banner (`[rtk] /!\ No hook installed — run rtk init -g for automatic token savings`) to `stdout` whenever Claude Code hooks are uninitialized. In autonomous agent environments, this unprompted banner pollutes context tokens and corrupts shell command rewrites (`[rtk] warning ... rtk git status`). Setting `suppress_hook_warning = true` completely silences this banner natively without requiring a fork of upstream RTK. |

### Configuration Lifecycle & Preservation Guarantee

1. **Automatic Initialization**: On a fresh installation, if no `config.toml` exists, `ensureRtkConfigured()` initializes `config.toml` with `[hooks]\nsuppress_hook_warning = true`.
2. **Non-Destructive Update**: If `config.toml` already exists, `ensureRtkConfigured()` safely checks whether `suppress_hook_warning` is absent or set to `false`, updating only this key while strictly preserving all existing user sections (`[general]`, `[telemetry]`, custom parameters, and comments).
3. **Direct Root Resolution (Zero Brittle Output Filtering)**: By standardizing `suppress_hook_warning = true` directly at the engine configuration layer, RTK suppresses banner output at the source. This eliminates the need for brittle regex or post-hoc line filtering in the execution hook, ensuring piped commands (`cmd1 | cmd2`), multiline scripts, and commands referencing `rtk` are delivered to the shell completely untouched.
