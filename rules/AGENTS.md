# Antigravity Execution & Context Governance (Agy-Context-Saver + RTK)

## Core Architectural Boundary
- **RTK (Rust Token Killer)**: Owns shell command transparent rewriting, output reduction, and compact codebase inspection (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk err`, `rtk summary`).
- **Agy-Context-Saver**: Owns Antigravity lifecycle governance, Reactive Wakeup enforcement, transcript forensics, and session integrity.

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

## Layer 2: Transparent Shell Execution & Codebase Inspection via RTK
- **Native Shell Commands**: Run shell commands normally using `run_command`. The PreToolUse hook transparently rewrites supported commands via RTK (`git`, `pytest`, `cargo`, `npm`, etc.) to produce ultra-compact outputs.
- **Canonical Codebase Inspection**: Native file and search inspection tools (`view_file`, `grep_search`, `find_by_name`, `list_dir`) that bypass RTK are blocked for workspace files. Use RTK's canonical CLI interfaces via `run_command`:
  - `rtk read <file>`: Read file with intelligent token filtering and line ranges.
  - `rtk find <path>`: Compact file search tree and directory listings (cross-platform, works on Windows & POSIX).
  - Search commands by platform:
    - **Windows**: Use `rtk rg "<pattern>" .` (explicit target `.` is required to prevent stdin pipe hanging) or `rg "<pattern>" .`.
    - **POSIX / Linux / macOS**: Use `rtk grep "<pattern>"` or `rtk rg "<pattern>"`.
  - Directory listing by platform:
    - **Windows**: Use `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`. (Avoid `rtk ls` or `rtk tree` on Windows as they rely on POSIX binaries/flags).
    - **POSIX / Linux / macOS**: Use `rtk ls <path>` or `rtk tree`.
  - `rtk err <cmd>`: Run command and show only errors/warnings.
  - `rtk summary <cmd>`: Run command and produce a 2-line heuristic summary.
- **Antigravity Special Files Safe Harbor**: Documented Antigravity special files (`SKILL.md`, brain artifacts, `.gemini/config/` configs) are permitted via `view_file`.
- **Protected Internal State**: Direct native inspection of `.system_generated/` (transcripts, task logs, progress files) is strictly forbidden. Use Agy MCP tools `read_transcript` and `query_transcript`.

---

## Layer 3: Synchronous Execution & Subagent Delegation
- **Maximum Synchronous Window**: Non-daemon `run_command` calls are automatically set to `WaitMsBeforeAsync: 10000` to complete synchronously and prevent unnecessary background detachment.
- **Targeted Test Execution & Bare Sweep Ban (LH-11)**:
  - **NEVER** run bare test runner commands (e.g. `pytest`, `python -m pytest`, `cargo test`, `npm test`) across an entire codebase in an interactive turn without specifying target test files or fail-fast flags.
  - In sizable repositories, full sweeps run hundreds of tests and take 5–10 minutes, appearing deadlocked while RTK aggregates output.
  - Always target the specific test file or directory relevant to the immediate change (e.g. `pytest tests/test_core.py -q -x`).
  - PreToolUse automatically injects `-x -q` (fail-fast, quiet) if bare `pytest` is invoked.
  - If a full repository sweep is truly required: delegate it to a subagent (`invoke_subagent`).
- **Subagent Delegation**: Delegate heavy multi-file exploration and exploratory research to subagents (`invoke_subagent`). Subagents absorb intermediate steps and return high-signal summaries.
- **Benchmark / Evaluator Integrity**: Never mutate benchmark definitions, prompt templates, or scoring artifacts during an active evaluation without explicit user confirmation.

---

## Layer 4: Zero-Guesswork Testing & Verification Playbook
When an agent or developer tests this framework, follow this exact sequence without guessing:

1. **Verify Live Registration & Health (Fast, non-blocking)**:
   ```bash
   npm run status
   # or
   node mcp/index.js status
   ```
   *Expected*: Reports `HEALTHY & ACTIVE 🛡️` across plugin link, hook, MCP config, schemas, and RTK.

2. **Execute Full Automated Test Suite**:
   ```bash
   npm test
   ```
   *Expected*: All 5 test suites pass (Hook unit tests, MCP protocol tests, E2E probes, live system validation, lifecycle rollback).

3. **Verify Individual Layers On-Demand**:
   - Governance Hook: `node tests/test-hook.mjs`
   - MCP Protocol & JSON-RPC: `node tests/test-mcp.mjs`
   - E2E Probes: `node tests/test-e2e-probes.mjs`
   - Live System Checks: `node tests/test-installed-verification.mjs`
   - Lifecycle & Rollback: `node tests/test-lifecycle-rollback.mjs`

4. **Verify MCP Tools in Antigravity**:
   - `get_installation_status`: Inspect live integration layers.
   - `check_context_health`: Pass `{ "transcriptPath": "<path-to-transcript.jsonl>" }`.
   - `read_transcript`: Pass `{ "conversationId": "<uuid>", "lastTurns": 3, "mode": "compact" }`.
   - `query_transcript`: Pass `{ "conversationId": "<uuid>", "query": "<pattern>", "summaryOnly": true }`.
   - `subagent_brief`: Pass `{ "objective": "<goal>", "scopeFiles": ["..."] }`.

5. **Operational Anti-Patterns (What NOT to do)**:
   - ❌ **Do NOT run `npm start` or `node mcp/index.js` interactively**: It starts the stdio JSON-RPC daemon and waits indefinitely on stdin.
   - ❌ **Do NOT run `manage_task(Action='status')` loops**: Status polling is governed; 5 polls trigger the `force_ask` circuit breaker.
   - ❌ **Do NOT run `npm run uninstall` as an isolated test**: It strips the live hook from `~/.gemini/config/`. If run, immediately re-run `npm run setup`.
   - ❌ **Do NOT omit explicit target paths with `rtk rg`**: Always provide a path (e.g. `rtk rg "pattern" .`) to prevent stdin blocking.
