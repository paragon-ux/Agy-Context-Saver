# Antigravity Execution & Context Governance (Agy-Context-Saver + RTK)

## Architectural Boundary
- **RTK (`>= 1.1.0`)**: Rewrites shell commands via `rtk hook antigravity`, compresses command output, and provides workspace search and file listing (`rtk grep`, `rtk find`, `rtk ls`, `rtk read`, `rtk err`, `rtk summary`).
- **Agy-Context-Saver (`v2.0.1`)**: Governs background task polling and Reactive Wakeup, bounds `read_file` slices, protects `.system_generated/` and the state directory, and provides transcript inspection and access control via `agy-context transcript`.

---

## Layer 1: Background Tasks & Proportional Backoff
- **No busy-polling**: Do not call `manage_task(Action='status')` in loops or schedule short timers to poll running background tasks. Background tasks resume the agent automatically via **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
- **No blocking CLI watch loops**: Never run blocking CI poll watches (`gh pr checks --watch`, `gh run watch`) inside `run_command`; run one-shot snapshots (`gh pr checks`, `gh run list`) instead.
- **Proportional backoff**: Diagnostic status checks follow an exponential cooldown curve:
  $\text{Cooldown} = \min(600, \text{round}(30 \times 2.5^{\text{pollCount} - 1})) \quad [0\text{s} \to 30\text{s} \to 75\text{s} \to 188\text{s} \to 469\text{s} \to 600\text{s}]$
  - Check #1 (immediate upon launch): permitted ($0\text{s}$).
  - Premature checks inside an active backoff window are denied. 5 cumulative denials trip the `force_ask` circuit breaker.
  - Once a backoff window elapses, one diagnostic check is permitted to inspect logs or issue `manage_task(Action='kill')`.
- **Coordinated watchdog timers (`schedule`)**: For background shell tasks (`run_command` builds, migrations, full test runs) expected to take $> 15\text{s}$:
  - Schedule a watchdog timer: `schedule(DurationSeconds=45, Prompt="Check status of background task-X", TimerCondition="task-X")`.
  - Watchdog timers must satisfy `DurationSeconds >= Math.max(30, requiredBackoffSec)`. Each task watchdog advances the backoff level ($30\text{s} \to 75\text{s} \to 188\text{s} \to 469\text{s} \to 600\text{s}$), so repeated $45\text{s}/60\text{s}$ timers are denied.
  - **Swarm and subagent exemption (`swarm_wait` only)**: Never pair `swarm_wait` or subagent launches with a one-shot `schedule` timer. `swarm_wait` sleeps at zero token cost and wakes on board posts; one-shot `schedule` timers polling a swarm or subagent are denied.
- **Pre-yield status card**: When a command moves to the background, output a status card before ending your turn:
  ```markdown
  ### ⏳ Background Execution Started
  - **Command**: `<cmd>`
  - **Scope / Target**: `<scope>`
  - **Estimated Duration**: `~X minutes`
  - **Watchdog Active**: Coordinated check scheduled in 45s via Reactive Wakeup.
  ```
- **Immediate kill and stdin**: `manage_task(Action='kill')` and `manage_task(Action='send_input')` are always allowed immediately ($0\text{s}$ cooldown, zero penalties).

---

## Layer 2: Shell Execution, Workspace Inspection & Transcript Governance
- **Shell commands**: Run commands via `run_command`. The `PreToolUse` hook delegates command rewriting to `rtk hook antigravity` (`git`, `pytest`, `cargo`, `npm`, etc.).
- **Workspace file and codebase inspection**: Unbounded full-file reads are blocked on workspace files. Follow this 3-tier workflow:
  1. **Tier 1 (Search and discovery: `rtk grep`, `rtk find`, `rtk ls`)**:
     - **Pattern and symbol search**: Run `rtk grep -rnE "<pattern>" <path>` via `run_command` to locate `[StartLine, EndLine]` line numbers. Always pass an explicit path (such as `.` or `src/`) so `rtk grep` does not wait on stdin.
     - **Directory and file listing**: Run `rtk find <path>`, `rtk ls <path>`, or `rtk tree` (or PowerShell `dir` / `Get-ChildItem` on Windows).
  2. **Tier 2 (Workspace file reading: `read_file` slice policy)**:
     - Pass `StartLine` and `EndLine` to `read_file` in bounded slices of `1-150` lines to preserve 1-indexed line numbers for `edit_file` and `write_file`.
     - Partial slices of `151-800` lines and `ByteOffset`-only unbounded reads are denied. A single-pass full-file read (`StartLine: 1, EndLine: <TotalLines>`) is permitted when the file on disk is $\le 800$ lines and $\le 45\text{ KiB}$ (`46,080` bytes).
  3. **Tier 3 (Spillovers and diagnostics: `rtk read`, `rtk err`, `rtk summary`)**:
     - **Spillovers and task logs**: Read `.system_generated/steps/<step>/output.txt` spillovers via bounded `read_file` ($\le 150$ lines) or `rtk read --tail-lines 150 <path>` / `--head-lines 150 <path>`, and completed `tasks/<taskId>.log` files via `rtk read <path>`. Do not use `rtk read -l minimal|aggressive` or `-m` to derive line numbers for `edit_file` or `write_file`.
     - **Command diagnostics**: Use `rtk err <cmd>` (errors and warnings only) and `rtk summary <cmd>` (2-line summary).
- **Safe harbor files**: Antigravity special files (`SKILL.md`, `AGENTS.md`, brain artifacts, `swarm_view/` narrator state, `.gemini/config/` files) are allowed via `read_file` without slice bounds.
- **Transcript forensics (`agy-context transcript`)**: Direct file or shell access to `.system_generated/` transcripts, task logs, progress files, or `getStateDir()` (`~/.local/state/agy-context-saver` on POSIX, `%LOCALAPPDATA%\agy-context-saver` on Windows) is blocked across `antigravity`, `antigravity-cli`, and `antigravity-ide` brain roots. Run `agy-context transcript` as a single unchained `run_command` (no `&&`, `||`, `;`, `|`, redirects, or `..` traversal; prefer batch step ranges `step <N,M|N-M>` and `query --start N --end M` over single-step loops):
  - `agy-context transcript read [<id>] [--id <uuid>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--outline] [--include-thinking] [--json]`
  - `agy-context transcript query [<pattern>] [<id>] [--id <uuid>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--include-thinking] [--json]` (aliases: `grep`, `search`, `find`, `tools`, `outline`, `summary`)
  - `agy-context transcript step [<N|N,M|N-M|N..M>] [<id>] [--id <uuid>] (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--head N] [--tail N] [--full] [--json]`
  - `agy-context transcript health [<id>] [--id <uuid>] [--json]` (aliases: `stats`, `info`)
  - `agy-context transcript list [--limit N] [--parent <uuid>] [--lineage] [--json]` (alias: `ls`)
  - `agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--out|--output <path>] [--file <path>] [--json]` (alias: `dump`)
  - `agy-context transcript access [status|off|on|reset|self-only] [--status | --off (--deny-children) | --on (--reset) | --self-only | --mode <open|allowlist|self-only|deny> | --allow <id,@roster*...> | --deny <id,@roster*...> | --ttl <sec>] [--json]` (alias: `policy`)
- **Parent transcript access control**:
  - **CLI policy**: Parents can restrict or scope child transcript access mid-session via `agy-context transcript access` (`policy`), using `--off` (`--deny-children`), `--self-only`, `--mode <open|allowlist|self-only|deny>`, `--allow <id,@roster*...>`, `--deny <id,@roster*...>`, `--ttl <sec>`, and `--on` (`--reset`).
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
