# Antigravity Execution & Context Governance (Agy-Context-Saver + RTK)

## Architectural Boundary
- **RTK (`>= 1.1.0`)**: Rewrites shell commands via `rtk hook antigravity`, compresses command output, provides workspace search and file listing (`rtk grep`, `rtk find`, `rtk ls`), reads spillovers and completed task logs (`rtk read`), and filters errors or summaries (`rtk err`, `rtk summary`).
- **Agy-Context-Saver (`v2.1.1`)**: Governs background task polling and Reactive Wakeup with per-task stall-watchdog backoff, bounds `read_file` slices, protects `.system_generated/` and the state directory, and provides two-tier transcript inspection (`~9.2 KB` inline defaults + `--full`/`--out` `512 KB` deep mode) and access control via `agy-context transcript`.

---

## Layer 1: Background Tasks & Proportional Backoff
- **No busy-polling**: Do not call `manage_task(Action='status')` in loops or schedule short or unconditioned polling timers. Background tasks resume the agent automatically via **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
- **No blocking CLI watch loops**: Never run blocking CI poll watches (`gh pr checks --watch`, `gh run watch`) inside `run_command`; run one-shot snapshots (`gh pr checks`, `gh run list`) instead.
- **Per-task proportional backoff**: Diagnostic status checks are tracked per task (`session.taskBackoff[taskKey]`, pruned automatically when a task completes or expires) along an exponential cooldown curve:
  `Cooldown = min(600, round(30 * 2.5^(pollCount - 1)))` (`0s -> 30s -> 75s -> 188s -> 469s -> 600s`)
  - Check #1 (immediate upon launch): permitted (`0s`) for each distinct task without cross-task bleed from earlier tasks.
  - Premature checks inside an active backoff window are denied. 5 cumulative denials trip the `force_ask` circuit breaker.
  - Once a backoff window or armed watchdog elapses, one diagnostic check (`manage_task(Action='status')`) is permitted to inspect progress or issue `manage_task(Action='kill')`.
- **Mandatory conditioned stall watchdogs (`schedule`)**: Whenever ANY `run_command` moves to the background (not just commands expected to run long):
  - Always arm an auto-cancelling watchdog bound to that task: `schedule(DurationSeconds=45, Prompt="Check status of background task-X", TimerCondition="<convId>/task-X")`. When the task finishes normally, `TimerCondition` cancels the timer automatically at zero token cost.
  - Watchdog timers scale per task (`30s -> 75s -> 188s -> 469s -> 600s`). Conditioned task watchdogs with `DurationSeconds >= 15` that fall below the task's current required backoff are auto-clamped (`overwrite: { DurationSeconds: requiredBackoffSec }`) instead of stripping monitoring; abusive micro-polls (`< 15s`) and unconditioned polling loops are hard-denied.
  - On watchdog wakeup, inspect with `manage_task(Action='status')` for stalled, frozen (TTY stop), runaway, or harmful behavior: if stalled or unsafe, terminate immediately via `manage_task(Action='kill')` (`0s` cooldown); if making healthy progress, re-arm the next backoff-level conditioned watchdog (`75s`, `188s`, `469s`, `600s`) before yielding.
  - **Direct `invoke_subagent` stall watchdogs vs. `/swarm` ban**:
    - For `/swarm` cohorts, never pair `swarm_wait` with a one-shot `schedule` timer (`swarm` / `board` / `squad` one-shot timers remain strictly denied because `swarm_wait` sleeps at zero token cost and the `swarm_monitor` `*/3` daemon cron detects stalls).
    - For direct `invoke_subagent` runs, you may optionally arm a stall-safety watchdog bound to that specific subagent conversation ID: `schedule(DurationSeconds=180, Prompt="Check if subagent <convId> stalled", TimerCondition="<subagentConvId>")` (recommended `180s-300s`). Direct-subagent watchdogs track per subagent ID along `180s -> 450s -> 600s` (`30s..179s` auto-clamp up to the required floor; `< 30s` or unconditioned subagent polling is denied).
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

## Layer 2: Shell Execution, Workspace Inspection & Transcript Governance
- **Shell commands**: Run commands via `run_command`. The `PreToolUse` hook delegates command rewriting to `rtk hook antigravity` (`git`, `pytest`, `cargo`, `npm`, etc.).
- **Workspace file and codebase inspection**: Unbounded full-file reads are blocked on workspace files. Follow this 3-tier workflow:
  1. **Tier 1 (Search and discovery: `rtk grep`, `rtk find`, `rtk ls`)**:
     - **Pattern and symbol search**: Run `rtk grep -rnE "<pattern>" <path>` via `run_command` to locate `[StartLine, EndLine]` line numbers (always pass an explicit path such as `.` or `src/` so `rtk grep` does not wait on stdin). Note: `rtk grep` compresses output (`~80`-char lines, `25` matches/file, ephemeral `rtk recall` hashes unreadable from transcripts), so implicit `grep` commands stay unrewritten for lossless inspection when full lines or `>25` matches per file are needed.
     - **Directory and file listing**: Run `rtk find <path>`, `rtk ls <path>`, or `rtk tree` (or PowerShell `dir` / `Get-ChildItem` on Windows).
  2. **Tier 2 (Workspace file reading: `read_file` slice policy)**:
     - Pass `StartLine` and `EndLine` to `read_file` in bounded slices of `1-150` lines to preserve 1-indexed line numbers for `edit_file` and `write_file`.
     - Partial slices of `151-800` lines and `ByteOffset`-only unbounded reads are denied. A single-pass full-file read (`StartLine: 1, EndLine: <TotalLines>`) is permitted when the file on disk is `<= 800` lines and `<= 45 KiB` (`46,080` bytes).
  3. **Tier 3 (Spillovers, completed task logs, and diagnostics: `rtk read`, `rtk err`, `rtk summary`)**:
     - **Spillovers and completed task logs only**: Read `.system_generated/steps/<step>/output.txt` spillovers via bounded `read_file` (`<= 150` lines) or single unchained `rtk read <path>`, and completed `tasks/<taskId>.log` files via `rtk read <path>` (`cat`, and single unquoted forward-slash `head -n 150` / `tail -n 150` auto-rewrite via `rtk`; use explicit `rtk read <path>` for bare `tail`, quoted/spaced paths, Windows backslash `head`/`tail`, or env prefixes, and `--head-lines 150` / `--tail-lines 150` are required on `>45 KiB` files). Never use `rtk read` to read or inspect editable workspace files; use bounded `read_file` slices so 1-indexed line numbers stay exact for `edit_file` (on `read_many_files` denials, use bounded `read_file` for editable code or `rtk read` for read-only logs/spillovers).
     - **Command diagnostics**: Use `rtk err <cmd>` (errors and warnings only) and `rtk summary <cmd>` (2-line summary).
- **Safe harbor files**: Antigravity special files (`SKILL.md`, `AGENTS.md`, brain artifacts, `swarm_view/` narrator state, `.gemini/config/` files) are allowed via `read_file` without slice bounds.
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
- **Benchmark integrity**: Never modify benchmark definitions, prompt templates, or scoring files (`edit_file`, `write_file`, or shell writes) during an evaluation without user confirmation.
