# Antigravity Execution & Context Governance (Agy-Context-Saver + RTK)

## Architectural Boundary
- **RTK (`>= 1.1.0`)**: Compresses noisy test, build, lint, container, and `git status`/`push`/`pull`/`fetch` stdout via the Narrow High-ROI Pre-Gate (`AGY_RTK_MODE=pregate|off|all`, default `pregate`), reads step spillovers and completed task logs (`rtk read`), and remains available explicitly (`rtk <cmd>`, `rtk err`, `rtk summary`). Precision inspection commands (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, workspace `cat`/`head`/`tail`, `ps`, `git diff`/`show`/`log`), pipelines, redirects, and `--json`/`--porcelain` commands stay untouched and lossless.
- **Agy-Context-Saver (`v2.1.2`)**: Governs background task polling and Reactive Wakeup with per-task stall-watchdog backoff, enforces `read_file` bounds on large files, protects `.system_generated/` and the state directory, and provides two-tier transcript inspection (`~9.2 KB` inline defaults + `--full`/`--out` `512 KB` deep mode) and parent access control via `agy-context transcript`.

---

## Layer 1: Background Tasks & Proportional Backoff
- **No busy-polling**: Do not call `manage_task(Action='status')` in loops or schedule short or unconditioned polling timers. Background tasks resume automatically via **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
- **No blocking CLI watch loops**: Never run blocking CI poll watches (`gh pr checks --watch`, `gh run watch`) inside `run_command`; run one-shot snapshots (`gh pr checks`, `gh run list`). When waiting on remote CI (GitHub Actions, CodeQL, PR checks), use a backoff-compliant `schedule` timer (`DurationSeconds >= 30`, scaling `30s -> 75s -> 188s -> 469s -> 600s`; `15..required-1` auto-clamps; no local `task-X` `TimerCondition` is required).
- **Per-task proportional backoff**: Diagnostic status checks are tracked per task (`session.taskBackoff[taskKey]`, pruned automatically when a task completes or expires) along an exponential cooldown curve:
  `Cooldown = min(600, round(30 * 2.5^(pollCount - 1)))` (`0s -> 30s -> 75s -> 188s -> 469s -> 600s`)
  - Check #1 (immediate upon launch): permitted (`0s`) for each distinct task **before** arming a `schedule` watchdog. Once `schedule` arms a watchdog for that task, `manage_task(Action='status')` waits until the watchdog cooldown elapses (calling Check #1 after `schedule` is denied by design).
  - Premature checks inside an active backoff window are denied. Reading raw `.system_generated/tasks/*.log` files while a task is `RUNNING` is always denied (even past cooldown); use `manage_task(Action='status')` instead. 5 cumulative denials trip the `force_ask` circuit breaker.
- **Mandatory conditioned stall watchdogs (`schedule`)**: Whenever ANY `run_command` moves to the background:
  - Arm an auto-cancelling watchdog bound to that task: `schedule(DurationSeconds=45, Prompt="Check status of background task-X", TimerCondition="<convId>/task-X")`. When the task finishes normally, `TimerCondition` cancels the timer automatically at zero token cost.
  - Watchdog timers scale per task (`30s -> 75s -> 188s -> 469s -> 600s`). Conditioned task watchdogs with `DurationSeconds >= 15` that fall below the required floor auto-clamp (`overwrite: { DurationSeconds: requiredBackoffSec }`); abusive micro-polls (`< 15s`) and unconditioned task polling loops are hard-denied.
  - On watchdog wakeup, inspect with `manage_task(Action='status')` for stalls, TTY freezes, runaway loops, or unsafe output (`manage_task(Action='kill')` is always allowed at `0s`), and re-arm the next backoff-level watchdog (`75s`, `188s`, `469s`, `600s`) if still progressing.
  - **Direct `invoke_subagent` stall watchdogs vs. `/swarm` ban**:
    - For `/swarm` cohorts, never pair `swarm_wait` with a one-shot `schedule` timer (`swarm` / `squad` / `board` one-shot timers without a `task-*` `TimerCondition` remain strictly denied because `swarm_wait` sleeps at zero token cost and `swarm_monitor` `*/3` detects stalls).
    - For direct `invoke_subagent` runs, you may optionally arm a stall-safety watchdog bound to that specific subagent conversation ID: `schedule(DurationSeconds=180, Prompt="Check if subagent <convId> stalled", TimerCondition="<subagentConvId>")` (recommended `180s-300s`, scaling `180s -> 450s -> 600s`; `30s..179s` auto-clamp, `< 30s` or unconditioned subagent polling is denied).
- **Pre-yield status card**: When a command moves to the background, output a status card before ending your turn:
  ```markdown
  ### ⏳ Background Execution Started
  - **Command**: `<cmd>`
  - **Scope / Target**: `<scope>`
  - **Estimated Duration**: `~X minutes`
  - **Watchdog Active**: Conditioned check scheduled in 45s (`TimerCondition="<convId>/task-X"`) via Reactive Wakeup.
  ```
- **Immediate kill and stdin**: `manage_task(Action='kill')` and `manage_task(Action='send_input')` are always allowed immediately (`0s` cooldown, zero penalties).

---

## Layer 2: Shell Execution, File Bounds & Transcript Governance
- **Shell commands**: High-ROI noisy runners (`pytest`, `cargo test`/`build`, `vitest`, `jest`, `tsc`, `eslint`, `npm`/`pnpm`/`yarn` test/build/install, `docker`, `kubectl`, `git status`/`push`/`pull`/`fetch`) delegate through `rtk hook antigravity` automatically (`AGY_RTK_MODE=pregate`; set `off` for explicit-only RTK or `all` for legacy delegation). Precision tools (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, `ps`, `git diff`/`show`/`log`, workspace `cat`/`head`/`tail`), pipes, redirects, and `--json`/`--porcelain` commands run natively without RTK rewriting.
- **Workspace file bounds**: Native `grep_search`, `find_by_name`, and `list_dir` are allowed on workspace paths. `read_file` guardrails:
  - Small files (`<= 300` lines and `<= 24 KiB`), safe workspace media (`.png`, `.jpg`, `.webp`, `.pdf`, audio/video), and Antigravity special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, `swarm_view/`, `.gemini/config/`) need no line bounds.
  - Larger files accept bounded slices up to `300` lines (`StartLine`, `EndLine`, EOF-clamped), or explicit full-file audits (`StartLine: 1, EndLine >= TotalLines`) when `<= 800` lines and `<= 45 KiB`. `read_many_files` and `ByteOffset`-only reads are denied.
- **Spillovers & completed task logs**: Read `.system_generated/steps/<step>/output.txt` spillovers via bounded `read_file` (`<= 150` lines) or a single unchained `rtk read <path>`, and completed `tasks/<taskId>.log` files via a single unchained `rtk read <path>` (or `cat`/`head -n 150`/`tail -n 150` auto-rewritten to `rtk read`; `--head-lines 150` / `--tail-lines 150` required on `> 45 KiB` files). Never read `RUNNING` task logs directly.
- **Transcript forensics (`agy-context transcript`)**: Direct file or shell access to `.system_generated/` transcripts, task logs, progress files, or `getStateDir()` (`~/.local/state/agy-context-saver` on POSIX, `%LOCALAPPDATA%\agy-context-saver` on Windows) is blocked across `antigravity`, `antigravity-cli`, and `antigravity-ide` brain roots. Run `agy-context transcript` as a single unchained `run_command` (no `&&`, `||`, `;`, `|`, redirects, or `..` traversal; prefer batch step ranges `step <N,M|N-M>` and `query --start N --end M` over single-step loops):
  - `agy-context transcript read [<id>] [--id <uuid>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--outline] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json]`
  - `agy-context transcript query [<pattern>] [<id>] [--id <uuid>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json]` (aliases: `grep`, `search`, `find`, `tools`, `outline`, `summary`)
  - `agy-context transcript step [<N|N,M|N-M|N..M>] [<id>] [--id <uuid>] (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--head N] [--tail N] [--line-start N] [--line-end N] [--full] [--max-chars N] [--out <path>] [--json]`
  - `agy-context transcript health [<id>] [--id <uuid>] [--json]` (aliases: `stats`, `info`)
  - `agy-context transcript list [--limit N] [--parent <uuid>] [--lineage] [--json]` (alias: `ls`)
  - `agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--full] [--max-chars N] [--out|--output <path>] [--file <path>] [--json]` (alias: `dump`)
  - `agy-context transcript access [status|off|on|reset|self-only] [--status | --off (--deny-children) | --on (--reset) | --self-only | --mode <open|allowlist|self-only|deny> | --allow <id,@roster*...> | --deny <id,@roster*...> | --ttl <sec>] [--json]` (alias: `policy`)
- **Parent transcript access control**:
  - **CLI policy**: Parents can restrict or scope child transcript access mid-session via `agy-context transcript access` (`policy`), using `--off` (`--deny-children`), `--self-only`, `--mode <open|allowlist|self-only|deny>`, `--allow <id,@roster*...>`, `--deny <id,@roster*...>`, `--ttl <sec>`, and `--on` (`--reset`, clearing `policies[ownerId]` only while Tier 4 child launch locks remain enforced and disclosed under `launchRestrictions`).
  - **First-line launch directives**: Place `[agy-transcript-access: deny]`, `[agy-transcript-access: self-only]`, or `[agy-transcript-access: allow]` on the first non-empty line of a `define_subagent` `SystemPrompt`, `invoke_subagent` `Prompt`, or `/swarm` worker `brief` (later lines and code blocks are ignored).
  - **Precedence**: `1. Policy Owner` -> `2. Explicit CLI --deny` -> `3. Explicit CLI --allow` (supports `@roster*` prefix globs such as `@audit-squad*`) -> `4. First-Line Launch Directive` -> `5. Cohort Default Mode`.
  - **When restricted**: If transcript access is denied for a child agent, do not retry `agy-context transcript` or probe `.system_generated` / `getStateDir()`; 5 blocked attempts trigger the `force_ask` circuit breaker.
- **Git line-ending warnings**: Suppress non-actionable Git CRLF/LF notices during repo operations (`git -c core.safecrlf=false`).

---

## Layer 3: Synchronous Execution
- **Default 10s synchronous window**: Non-daemon `run_command` calls default to `WaitMsBeforeAsync: 10000` when omitted so short commands complete in-turn (explicit caller values are preserved).
- **Targeted test execution**:
  - In interactive turns, target specific test files or directories rather than running multi-minute full-repo suites.
  - Use fail-fast flags (`-x`, `--maxfail=1`) when debugging a localized failure; omit them when checking full blast radius.
  - Pair multi-minute test sweeps with a `schedule(DurationSeconds=45, ...)` watchdog timer and a Pre-Yield Status Card.
- **Benchmark integrity**: Edits to `benchmarks/`, `evaluation/`, `evaluators/`, `scoring/`, `ground_truth/`, or `prompt_templates/` prompt via `force_ask`. In non-evaluation repos, set `AGY_DISABLE_BENCHMARK_GUARD=1` to disable this prompt for top-level non-restricted sessions.
