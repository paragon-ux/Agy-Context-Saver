# Agy-Context-Saver

`Agy-Context-Saver` (`v2.1.2`) is a `PreToolUse` execution hook and transcript CLI (`agy-context`) for **Google Antigravity** (`agy`) on Linux, macOS, and Windows (`Node.js >= 22`, zero external npm dependencies). It pairs with **RTK (`>= 1.1.0`)**, a CLI proxy that compresses noisy shell and test output, to shrink command logs, enforce bounded workspace file reads, stop background-task busy-polling, and govern transcript inspection across parent sessions, subagents, and `/swarm` workers.

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

1. **Narrow High-ROI RTK Pre-Gate and 10s synchronous window:** The `PreToolUse` hook pre-gates `run_command` segments (`AGY_RTK_MODE=pregate|off|all`, default `pregate`) so only high-ROI noisy test/build/lint/container/`git status|push|pull|fetch` runners and scoped internal spillover/completed task-log reads delegate to `rtk hook antigravity` (`>= 1.1.0`), leaving precision inspection commands (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, `ps`, `git diff`/`show`/`log`, workspace `cat`/`head`/`tail`), pipes, stdout/file redirects, and machine-readable outputs untouched with zero RTK subprocess overhead, while upgrading unset `WaitMsBeforeAsync` to `10,000ms` on non-daemon commands.
2. **Native workspace discovery and unified `read_file` bounds:** Native `grep_search`, `find_by_name`, and `list_dir` run directly on workspace paths (still blocked on `.system_generated/`, `getStateDir()`, and protected brain roots). Small files ($\le 300$ lines and $\le 24\text{ KiB}$), safe workspace multimodal media, and Antigravity special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, `swarm_view/`, `.gemini/config/`) pass without slice bounds; larger files accept bounded `read_file` slices up to $300$ lines (EOF-clamped up to $1\text{ MiB}$, single-bound supported) or explicit `1..TotalLines` audits when $\le 800$ lines and $\le 45\text{ KiB}$. Step spillovers and `COMPLETED` task logs both allow bounded `read_file` ($\le 150$ lines) or single unchained `rtk read <path>`.
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
