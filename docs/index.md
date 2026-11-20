# Agy-Context-Saver

`Agy-Context-Saver` (`v2.1.1`) is a `PreToolUse` execution hook and transcript CLI (`agy-context`) for **Google Antigravity** (`agy`) on Linux, macOS, and Windows (`Node.js >= 22`, zero external npm dependencies). It pairs with **RTK (`>= 1.1.0`)**, a CLI proxy that compresses noisy shell and test output, to shrink command logs, enforce bounded workspace file reads, stop background-task busy-polling, and govern transcript inspection across parent sessions, subagents, and `/swarm` workers.

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

## Start here

- **[Installation and setup](installation.md):** Prerequisites, `npx` and local repository setup, status verification, and backup restoration.
- **[CLI and hook reference](tools.md):** Subcommands, aliases, and flags for `agy-context transcript` (`health`, `read`, `query`, `step`, `list`, `export`, `access`) and `agy-context` (`status`, `setup`, `uninstall`, `restore-backups`).
- **[Lifecycle governance](governance.md):** Exponential backoff on background task checks, Reactive Wakeup coordination, 3-tier workspace inspection, and parent-controlled child transcript access.
- **[Architecture and internals](architecture.md):** Execution flow across `PreToolUse`, `rtk hook antigravity`, `lib/transcript-core.mjs`, single-use capability grants, and streaming memory bounds.
- **[Installer hardening](INSTALLER-HARDENING.md) & [RTK support matrix](RTK-SUPPORT-MATRIX.md):** Read-only preflight validation, SHA-256 binary verification, and RTK `config.toml` settings.
- **[Publishing and verification](publishing.md):** Release preflight checks, the 12-suite test matrix, and tarball verification.
- **[Product roadmap](roadmap.md):** Shipped milestones and upcoming work.

## Core capabilities

1. **Shell output compression and 10s synchronous window:** The `PreToolUse` hook delegates `run_command` rewriting to `rtk hook antigravity` (`rtk git`, `rtk pytest`, `rtk cargo`, `rtk npm`), reverts lossy implicit `wc`/`ls`/`diff`/`grep` rewrites, and upgrades unset `WaitMsBeforeAsync` to `10,000ms` on non-daemon commands.
2. **Bounded workspace file inspection:** Unbounded `read_file` calls on workspace files are redirected to `rtk grep`, `rtk find`, and `rtk ls` paired with bounded `read_file(StartLine, EndLine <= 150)` slices (or explicit `1..TotalLines` reads for files `<= 800` lines and `<= 45 KiB`). Antigravity special files (`SKILL.md`, `AGENTS.md`, brain artifacts, `swarm_view/` narrator state, `.gemini/config/`) pass through without slice bounds.
3. **Reactive Wakeup and per-task stall-watchdog backoff:** Premature `manage_task(Action='status')` checks, unconditioned polling loops, and `/swarm` one-shot timers are blocked along a per-task exponential backoff curve (`0s -> 30s -> 75s -> 188s -> 469s -> 600s`, tripping a `force_ask` circuit breaker at 5 cumulative denials), while conditioned task watchdogs (`>= 15s`) and optional direct-subagent stall watchdogs (`TimerCondition="<subagentConvId>"`, `180s -> 450s -> 600s`) auto-clamp to the required floor instead of dropping stall monitoring.
4. **CLI transcript forensics and parent access control:** `agy-context transcript` streams Markdown turns, searches compact and truncated steps, and extracts step ranges without MCP schema overhead. Parents can restrict or allowlist child subagents and `/swarm` workers on demand via `agy-context transcript access` or first-line `[agy-transcript-access: deny|self-only|allow]` launch directives.

## How Agy-Context-Saver guards a default session

Agy-Context-Saver layers a pre-tool hook on top of Google Antigravity's native shell, file, and task tools rather than replacing them (see [Architecture and internals](architecture.md)):

![Default Antigravity session vs. Antigravity with Agy-Context-Saver](assets/default-vs-context-saver.svg)

## Quickstart

=== "NPX"
    ```bash
    npx --package=agy-context-saver agy-context setup
    ```

=== "Local checkout"
    ```bash
    npm run setup
    ```

=== "Check status"
    ```bash
    agy-context status
    # Or without editing PATH:
    npx --package=agy-context-saver agy-context status
    ```

## Companion integration: Agy-Squad

Multi-agent cohort planning, role-separated review gates, and SHA-256 evidence bundling live in the separate [Agy-Squad](https://paragon-ux.github.io/Agy-Squad/) package. When running Agy-Squad cohorts on `/swarm`, parents can lock down leaf specialists while granting cross-session transcript inspection to flat integrity auditors:

```bash
agy-context transcript access --mode allowlist --allow @audit-squad*
```
