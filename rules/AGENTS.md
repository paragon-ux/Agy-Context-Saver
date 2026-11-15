# Antigravity Execution & Context Governance (Agy-Context-Saver + RTK)

## Core Architectural Boundary
- **RTK (Rust Token Killer >= 1.1.0)**: Owns shell command transparent rewriting (`rtk hook antigravity`), output reduction, and compact codebase inspection (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk err`, `rtk summary`).
- **Agy-Context-Saver (v2.0.0 CLI-First)**: Owns Antigravity lifecycle governance, Reactive Wakeup enforcement, transcript forensics (`agy-context transcript ...`), and session integrity.

---

## Layer 1: Background Tasks & Proportional Backoff Protocol (Reactive Wakeup SSOT)
- **Zero-Tolerance on Busy-Polling**: Do NOT call `manage_task(Action='status')` in tight loops or schedule rapid timers to wait for running background tasks. Background tasks execute asynchronously and automatically resume the agent via **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
- **Proportional Backoff Protocol**: Diagnostic inspections scale along an exponential backoff curve:
  $\text{Cooldown} = \min(600, \text{round}(30 \times 2.5^{\text{pollCount} - 1})) \quad [0\text{s} \to 30\text{s} \to 75\text{s} \to 188\text{s} \to 469\text{s} \to 600\text{s}]$
  - Check #1 (Immediate upon launch): Permitted ($0\text{s}$).
  - Premature status checks within an active backoff window are denied. 5 consecutive premature checks trigger the `force_ask` circuit breaker.
  - Silent/hung background tasks: Once the backoff window elapses, a single diagnostic check is permitted to inspect logs, detect deadlocks, and issue `manage_task(Action='kill')` if needed.
- **Coordinated Watchdog Protocol (`schedule`)**: For long-running operations (builds, migrations, test suites) expected to take $> 15\text{s}$:
  - Schedule a coordinated watchdog timer: `schedule(DurationSeconds=45, Prompt="Check status of background task-X", TimerCondition="task-X")`.
  - Watchdog timers must satisfy `DurationSeconds >= Math.max(30, requiredBackoffSec)`. Short timers are denied.
  - If the task completes early, Reactive Wakeup auto-cancels the timer and resumes the agent immediately.
  - If the task is still running when the watchdog fires, perform a legal diagnostic check (`manage_task(status)`) and post a live progress update in chat for the user.
- **Mandatory Pre-Yield Status Card**: When a command moves to the background, NEVER yield with a silent or generic one-liner. Output a structured Markdown card so the user is never left wondering if the IDE has stalled:
  ```markdown
  ### ⏳ Background Execution Started
  - **Command**: `<cmd>`
  - **Scope / Target**: `<scope>`
  - **Estimated Duration**: `~X minutes`
  - **Watchdog Active**: Coordinated check scheduled in 45s via Reactive Wakeup.
  ```
- **Kill & Stdin Immediate Exemption**: `manage_task(Action='kill')` and `manage_task(Action='send_input')` are ALWAYS permitted immediately ($0\text{s}$ backoff, zero penalties).

---

## Layer 2: Transparent Shell Execution & Unified Codebase Inspection
- **Native Shell Commands**: Run shell commands normally using `run_command`. The PreToolUse hook delegates command rewriting to `rtk hook antigravity` (`git`, `pytest`, `cargo`, `npm`, etc.) to produce ultra-compact outputs.
- **Unified Codebase & File Inspection**: Unbounded full-file reads and unoptimized search tools (`grep_search`, `find_by_name`, `list_dir`) are blocked for workspace files. Follow this hierarchy:
  1. **Tier 1 — Compact Search & Discovery (`rtk grep`, `rtk find`, `rtk ls`)**:
     - **Prose / Regex / Symbol Discovery**: Use `rtk grep -rnE "<pattern>" <path>` via `run_command` to locate exact `[StartLine, EndLine]` coordinates without dumping unoptimized search payloads. Always provide an explicit target path (e.g., `.` or `src/`) to prevent stdin pipe stalls.
     - **Directory / File Discovery**:
       - **Windows**: Use `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`.
       - **POSIX / Linux / macOS**: Use `rtk find <path>`, `rtk ls <path>`, or `rtk tree`.
  2. **Tier 2 — Precision Workspace File Reading (`read_file` Hybrid Slice Policy)**:
     - Pass exact `StartLine` and `EndLine` into `read_file` (bounded slices of `1–150` lines) to preserve 1-indexed line numbers for `edit_file` and `write_file` without terminal stdout truncation.
     - Partial slices of `151–800` lines and `ByteOffset`-only unbounded reads are denied; an explicit one-pass full-file audit (`StartLine: 1, EndLine: <TotalLines>`) is permitted only when the file on disk is $\le 800$ lines and $\le 45\text{ KiB}$ (`46,080` bytes).
  3. **Tier 3 — RTK Spillover & Diagnostic Boundaries (`rtk read`, `rtk err`, `rtk summary`)**:
     - **Spillovers & Task Logs**: Read `.system_generated/steps/<step>/output.txt` spillovers (or use bounded `read_file` $\le 150$ lines) and completed `tasks/<taskId>.log` files via `rtk read <path>` (with `--head-lines` / `--tail-lines`). Never use `rtk read -l minimal|aggressive` or `-m` to derive line numbers for `edit_file` / `write_file`.
     - **Command Diagnostics**: `rtk err <cmd>` (errors/warnings only) and `rtk summary <cmd>` (2-line heuristic summary).
- **Antigravity Special Files Safe Harbor**: Documented Antigravity special files (`SKILL.md`, brain artifacts, `.gemini/config/` configs) are permitted via `read_file` without slice bounds, and bounded `read_file` ($\le 150$ lines) is permitted on `.system_generated/steps/<n>/output.txt`.
- **Protected Internal State & Transcript Forensics (`agy-context transcript ...`)**: Direct native inspection of `.system_generated/` transcripts, task logs, or progress files is strictly forbidden. Use the zero-MCP `agy-context` CLI via `run_command`:
  - `agy-context transcript read [--id <uuid>] [--mode compact|full] [--last-turns N] [--include-thinking] [--json]`
  - `agy-context transcript query [--id <uuid>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--include-thinking] [--json]`
  - `agy-context transcript step --id <uuid> (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--json]`
  - `agy-context transcript health [--id <uuid>] [--json]`
- **Git CRLF/LF Warning Hygiene**: Git's line-ending conversion notices (`warning: LF will be replaced by CRLF the next time Git touches it` / `warning: CRLF will be replaced by LF...`) are non-actionable diagnostic noise. Suppress them during repo operations (via `git -c core.safecrlf=false` or `git config --global core.safecrlf false`) and do not propagate them into task outputs or conversation context.

---

## Layer 3: Synchronous Execution
- **Maximum Synchronous Window**: Non-daemon `run_command` calls default to `WaitMsBeforeAsync: 10000` when omitted to complete synchronously and prevent unnecessary background detachment (explicit positive caller values are preserved).
- **Targeted Test Execution & Opt-In Fail-Fast (LH-11)**:
  - **Targeted Invocations**: In interactive turns, prefer targeting specific test files or directories (e.g. `pytest tests/test_core.py`) rather than running full multi-minute repository sweeps.
  - **Fail-Fast Flags are Opt-In**: Fail-fast flags (`-x`, `--maxfail=1`) are opt-in. Use them when quickly debugging a localized failure, but omit them when assessing the full blast radius across the codebase to avoid the "whack-a-mole" loop.
  - **Coordinated Watchdog Mandatory for Full Sweeps**: When running full multi-minute test sweeps without `-x`, agents **MUST** pair execution with the **Coordinated Watchdog Protocol** (`schedule(DurationSeconds=45, ...)`) and output a **Pre-Yield Status Card**. Never yield silently.
- **Benchmark / Evaluator Integrity**: Never mutate benchmark definitions, prompt templates, or scoring artifacts (`edit_file`, `write_file`, or shell writes) during an active evaluation without explicit user confirmation.

---

## Appendix: Zero-Guesswork Testing & Verification Playbook
When an agent or developer tests this framework, follow this exact sequence without guessing:

1. **Verify Live Registration & Health (Fast, non-blocking)**:
   ```bash
   npm run status
   # or
   agy-context status
   ```
   *Expected*: Reports `HEALTHY & ACTIVE` across plugin link, `agy-context-saver` hook, `agy-context` CLI shim, RTK (`>= 1.1.0`), and MCP cleanup (`0` duplicate MCP configs/schemas).

2. **Execute Full Automated Test Suite**:
   ```bash
   npm test
   ```
   *Expected*: All 11 test suites pass.

3. **Verify Transcript CLI On-Demand**:
   - `agy-context transcript health --id <uuid>`
   - `agy-context transcript read --id <uuid> --last-turns 3 --mode compact`
   - `agy-context transcript query --id <uuid> --query "<pattern>" --summary`
   - `agy-context transcript step --id <uuid> --step 0 --field content`

4. **Operational Anti-Patterns (What NOT to do)**:
   - ❌ **Do NOT run `manage_task(Action='status')` loops**: Status polling is governed; 5 polls trigger the `force_ask` circuit breaker.
   - ❌ **Do NOT run `npm run uninstall` as an isolated test**: It strips the live hook and CLI shims from `~/.gemini/`. If run, immediately re-run `npm run setup`.
   - ❌ **Do NOT omit explicit target paths with `rtk grep`**: Always provide a path (e.g. `rtk grep -rnE "pattern" .`) to prevent stdin pipe stalls.
   - ❌ **Do NOT chain `agy-context transcript ...` commands**: Run `agy-context transcript ...` as a strictly single, unchained `run_command` invocation without `&&`, `||`, `;`, `|`, redirects, or `..` traversal.
