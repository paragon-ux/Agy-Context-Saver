# Architecture & Internals

`Agy-Context-Saver` (`v2.3.0`) pairs a thin lazy-loaded `PreToolUse` hook router (`scripts/execution-guard-hook.mjs` dynamically importing `scripts/hook/{file,shell,task}-guard.mjs`) with a small CLI (`bin/agy-context.mjs`), shared governance libraries (`lib/path-guards.mjs`, `lib/backoff.mjs`, `scripts/state-dir.mjs`, `scripts/rtk-run.mjs`), and **RTK (`>= 1.1.0`)**, a CLI proxy that compresses noisy shell and test output.

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

---

## Default Session vs. Agy-Context-Saver

![Default Antigravity session vs. Antigravity with Agy-Context-Saver](assets/default-vs-context-saver.svg)

---

## Division of Responsibilities

### RTK (`>= 1.1.0`)
- Compresses noisy test, build, lint, container, and `git status`/`push`/`pull`/`fetch` stdout via the Narrow High-ROI Pre-Gate (`rtk hook antigravity`, configurable via `AGY_RTK_MODE=pregate|off`, default `pregate`).
- Reads step spillovers and completed task logs (`rtk read`, including `cat` and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrites) and filters command output on demand (`rtk err`, `rtk summary`).

### Agy-Context-Saver (`v2.3.0`)
- Enforces per-task Reactive Wakeup backoff, remote CI timers, and conditioned stall-watchdog auto-clamping on `manage_task` and `schedule` (`30s -> 75s -> 188s -> 469s -> 600s` per task/remote CI; `180s -> 450s -> 600s` per direct subagent), backed by a single global `PreToolUse` registration and a 5-strike `force_ask` circuit breaker.
- Bounds large workspace `read_file` calls (unified `800` lines / `45 KiB` rule: auto-allowing `<= 800` lines & `<= 45 KiB`, safe multimodal media, and special files; denying omitted bounds on larger files while allowing explicit slices up to `800` lines) while leaving native `grep_search`, `find_by_name`, and `list_dir` unblocked on workspace paths.
- Protects `.system_generated/logs` from writes and deletes, and the state directory (`getStateDir()`, `~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows) across all native file tools (including `multi_replace_file_content`) and symlinks, while cleanly allowing own-session `<ownBrainDir>/.system_generated/swarm/plan.json` (Swarm UI Overview), nested `logs/`/`tasks/`/`steps/` paths inside user `scratch/`/`browser_sandbox/`/`swarm_view/` brain subdirs (rejecting `..`, `$`, dotfiles, and `.system_generated/`), and top-level non-symlink `force_ask` edits to `mcp_config.json` / `config.json`.
- Reports session health (turns, steps, raw size, polling events) via the read-only `agy-context transcript health`. Native `read_file` and `grep_search` read `transcript.jsonl` directly.
- Guards benchmark and evaluation files against unapproved edits (`edit_file`, `write_file`, `replace_file_content`, `multi_replace_file_content`, and shell writes), with `AGY_DISABLE_BENCHMARK_GUARD=1` opt-out for top-level non-evaluation repos.

---

## Modular Hook Topology & Guardrail Boundary

### Single Global Hook Surface (No Standalone Mirror)
`agy-context setup` registers a single `PreToolUse` entry in `~/.gemini/config/hooks.json` pointing directly to `~/.gemini/config/plugins/agy-context-saver/scripts/execution-guard-hook.mjs` (the plugin's own `hooks.json` is `{}`). Every governed tool call across top-level sessions, subagents, and `/swarm` workers spawns **1** Node.js process with zero standalone `~/.gemini/config/scripts/` mirror copy and zero dual-hook deduplication or lockfile overhead (`setup` and `uninstall` automatically remove any legacy `~/.gemini/config/scripts/execution-guard-hook.mjs` mirror from earlier v2.x releases).

### Lazy-Loaded 3-Module Hook & Shared Libraries
Running directly inside the installed plugin directory allows the hook to stay modular and share single-source-of-truth helpers across the hook, CLI, and installer:
- **`scripts/execution-guard-hook.mjs`**: Thin stdin/stdout router that exits immediately for non-governed tools and dynamically `import()`s only the matching tool-family module:
  - **`scripts/hook/file-guard.mjs`**: Workspace discovery, unified `800L / 45 KiB` `read_file` bounds, bounded spillover/completed task-log reads (`<= 150` lines), narrow own-session `.system_generated/swarm/plan.json` allowlist (`read_file`/`write_file`/`edit_file` only), and file-write internal-state, user-config (`force_ask` for non-symlink `mcp_config.json`/`config.json`; hard-`deny` for global `hooks.json`, `*.bak`, symlinks, and ACS files), and benchmark checks.
  - **`scripts/hook/shell-guard.mjs`**: Segment-level Narrow High-ROI RTK Pre-Gate (`AGY_RTK_MODE=pregate|off`), direct `.system_generated/` and `getStateDir()` checks, linear brain subdir carve-outs (`scratch/`/`browser_sandbox/`/`swarm_view/`) and safe direct artifact extensions, non-destructive `force_ask` vs. destructive hard-`deny` on user configs, simple shell wrapper unwrapping (`sh -c`, `bash -c`, `cmd /c`), and `gh` blocking-watch protection.
  - **`scripts/hook/task-guard.mjs`**: Per-task and direct-subagent backoff ledger, remote CI `schedule` timers, conditioned watchdog auto-clamping, and 5-strike `force_ask` circuit breaker.
  - **`scripts/hook/common.mjs`**: Shared hook session-state, logging, and decision-response helpers.
- **Shared libraries**: `lib/path-guards.mjs` (canonical symlink-following `resolveRealOrAncestorPath()` and containment helpers), `lib/backoff.mjs` (shared backoff curve and polling detectors), `scripts/state-dir.mjs`, and `scripts/rtk-run.mjs`.

### Narrow Application-Layer Guardrail Boundary
`Agy-Context-Saver` provides **application-layer defense-in-depth** for accidental context bloat, direct internal-state access (`.system_generated/logs` writes, `getStateDir()`), symlinks, simple shell wrappers (`sh -c`, `bash -c`, `cmd /c`), — **not** an OS-kernel sandbox (`seccomp`, `Landlock`, or container namespace isolation). It intentionally does not attempt obfuscation decoding (such as Base64/Hex/encoded-command brute-force) or multi-language static analysis, and never blocks unrestricted top-level developer scripts.

---

## Technical Subsystems

### 1. Narrow High-ROI RTK Pre-Gate (`>= 1.1.0`)
The `PreToolUse` hook intercepts `run_command` via `scripts/hook/shell-guard.mjs`. After running internal state and task backoff checks, it evaluates each shell segment before spawning `rtk hook antigravity`:
- High-ROI noisy runners (`pytest`, `python -m pytest`/`mypy`, `uv run pytest`/`ruff`/`mypy`/`ty`, `cargo test`/`build`/`clippy`, `go test`/`build`/`vet`, `vitest`, `jest`, `tsc`, `eslint`, `ruff`, `npm run lint` / `npm lint`, `pnpm run lint` / `pnpm install`/`outdated`/`lint`/`tsc`/`list`, `bun test`/`build`/`install`/`add`, `docker build`/`ps`/`logs`/`compose ps|logs|build`, `kubectl get`/`logs`/`describe`/`apply`, `git status`/`push`/`pull`/`fetch`) and scoped internal spillover/completed task-log reads receive compact `rtk` rewrites (including inside `bash -c` / `sh -c` / `cmd /c` wrappers and `2>&1`/`2>/dev/null` stderr redirects).
- Precision inspection tools (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, `ps`, `git diff`/`show`/`log`, workspace `cat`/`head`/`tail`), generic `npm run`/`pnpm run`/`bun run` scripts (which only wrap `rtk <pm> run` for ~0.1% boilerplate stripping), pipes, stdout/file redirects, machine-readable outputs (`--json`, `--porcelain`, `git status -sb`, `-o json`, etc.), any explicit `--reporter`/`--reporters` flag on `vitest`/`jest` (direct or via `npx`/`bunx`, preventing RTK JSON-parser override and failure truncation), `npx`/`bunx` (and `pnpm tsc`) when a project-local `node_modules/.bin/<tool>` is shadowed by a different binary on global `PATH` (preventing WSL2 Windows-`tsc` crashes and version skew), and `vitest >= 5` projects when host RTK is `< 1.2.0` (`1.1.0`) bypass `rtk` completely (zero subprocess spawn, lossless output). Bare `rg` stays completely untouched and lossless even when host `rg` is absent (no silent `rg -> grep` transpilation). Explicit `rtk ...` invocations stay intact, and plugin-local off-`PATH` `rtk` (including `uv run rtk ...`) rewrites cleanly.
- Unset `WaitMsBeforeAsync` on non-daemon commands is upgraded to `10,000ms` so short commands finish in-turn.

### 2. Workspace File Bounds & Output Inspection
To prevent multi-thousand-line file dumps without obstructing normal exploration:
1. **Native workspace discovery:** `grep_search`, `find_by_name`, and `list_dir` run directly on workspace paths while remaining blocked on `getStateDir()`.
2. **Unified `read_file` / `view_file` bounds:** Workspace files (`<= 800` lines and `<= 45 KiB`), safe workspace multimodal media (`.png`, `.jpg`, `.webp`, `.pdf`, audio/video), and Antigravity special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, own `.system_generated/swarm/plan.json`, `swarm_view/`, `.gemini/config/`) pass without slice bounds. Larger files (`> 800` lines or `> 45 KiB`) deny omitted bounds and accept explicit slices up to `800` lines (EOF-clamped). `read_many_files` and `ByteOffset`-only reads remain denied.
3. **Spillovers and completed task logs:** Both step output spillovers (`.system_generated/steps/<step>/output.txt`) and completed background task logs (`tasks/<taskId>.log`) allow bounded `read_file` (`<= 150` lines) or single unchained `rtk read <path>` calls once finished (`cat`, and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`; `--head-lines 150` / `--tail-lines 150` required above `45 KiB`; `RUNNING` task logs are always denied).

### 3. Internal State, State Directory & Shell Wrapper Checks
Segment-, quote-, and heredoc-aware shell parsing and shared symlink-following path guards (`lib/path-guards.mjs`) protect `.system_generated/` and `getStateDir()`:
- Writes and deletes under `.system_generated/logs`, direct access to `getStateDir()`, running `tasks/*.log`, and `agy-session-*.json` is denied in `PreToolUse`. Narrow ergonomic carve-outs keep normal Antigravity workflows unblocked without weakening isolation: own-session `<ownBrainDir>/.system_generated/swarm/plan.json` allows non-symlink `read_file`/`write_file`/`edit_file` (denying symlinks, sibling sessions, `ByteOffset`, `read_many_files`, and discovery tools); linear `isProtectedBrainSubpath()` exempts user `scratch/`, `browser_sandbox/`, and `swarm_view/` subdirs from `logs/`|`tasks/`|`steps/` denials while keeping `..`, `$`, dotfiles, and `.system_generated/` denied everywhere alongside expanded safe direct artifact extensions (`.csv`, `.zip`, `.mp4`, etc.); and non-symlink edits to `mcp_config.json`/`config.json` prompt via `force_ask` while global `hooks.json`, `*.bak`, destructive shell verbs (`rm`/`mv`/`ln`/etc.), and ACS files stay hard-`deny`.
- Simple shell wrappers (`sh -c`, `bash -c`, `cmd /c`) are unwrapped for direct `.system_generated/` and `getStateDir()` checks, while developer scripts are allowed without obstruction.

### 4. Per-Task Lifecycle Ledger
Polling and watchdog counters are tracked per task and per direct subagent inside `<stateDir>/agy-session-<convId>.json` (`session.taskBackoff[taskKey]`, capped at 64 entries and automatically pruned when `getTaskState()` reports `COMPLETED` or past the 1-hour TTL, with flat `session.pollCount` kept only as a fallback for unkeyed calls; expired per-conversation `agy-session-*.json` files are also automatically pruned past the 1-hour TTL):
- Fresh background tasks always start at Level 0 (`0s` immediate Check #1 and `>= 30s` / `45s` conditioned watchdog) without cross-task bleed from earlier tasks.
- Conditioned task watchdogs (`>= 15s`) and conditioned direct-subagent stall watchdogs (`>= 30s`, bound to `TimerCondition="<subagentConvId>"`) auto-clamp via `overwrite: { DurationSeconds: requiredBackoffSec }` instead of stripping monitoring, while abusive micro-polls, unconditioned polling loops, and `/swarm` one-shot timers remain hard-denied.
- Prompt keywords (`debug`, `stuck`, `timeout`) do not bypass backoff rules.
- Reaching 5 cumulative denials across polling or internal state guards triggers `force_ask`, pausing autonomous execution and prompting the user.

---

## Resource and Streaming Design

- **Stream cleanup:** All `readline` and transcript file streams close inside `try / finally` blocks with explicit `fileStream.destroy()`.
- **Lazy hook dispatch & direct RTK delegation:** Non-governed tools exit immediately in `scripts/execution-guard-hook.mjs` without loading guard modules; eligible `run_command` segments spawn `rtk hook antigravity` directly over stdin JSON, falling back to plugin binary paths only on `ENOENT`.
- **256 KB tail-window task resolution & TTL pruning:** Task state checks scan the trailing 256 KB of `transcript.jsonl` once per pruning pass with literal substring matching before falling back to full-file reads, and expired `agy-session-*.json` files are pruned automatically past the 1-hour TTL.
- **Fast denial ordering:** Internal state guards and running task log denials execute before spawning `rtk hook antigravity`.
