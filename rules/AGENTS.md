# Antigravity Execution & Context Governance (Agy-Context-Saver + RTK)

## Core Architectural Boundary
- **RTK (Rust Token Killer)**: Owns shell command transparent rewriting, output reduction, and compact codebase inspection (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk err`, `rtk summary`).
- **Agy-Context-Saver**: Owns Antigravity lifecycle governance, Reactive Wakeup enforcement, transcript forensics, and session integrity.

---

## Layer 1: Background Tasks & Polling Ban (Reactive Wakeup SSOT)
- **Zero-Tolerance on Task Polling**: Do NOT call `manage_task(Action='status')` or `schedule` timers in a loop to wait for running background tasks. Background tasks execute asynchronously and automatically resume the agent via **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
- **Yield Turn Immediately**: When a process moves to the background, stop calling tools, output a concise status message, and yield the turn.
- **No Keyword or Timer Exemptions**: Words like "debug", "timeout", "diagnose", or "stuck" do NOT exempt an agent from lifecycle governance. Timers with `duration >= 120` are NOT exempt.
- **Circuit Breaker**: Repeated polling calls across any tasks in a session trigger an escalating circuit breaker. At 5 cumulative denials, autonomous execution is frozen via `force_ask`.

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
- **Targeted Test Execution**: Avoid massive multi-minute test sweeps in interactive turns. Run targeted, quiet, fail-fast commands (e.g. `pytest tests/test_core.py -q -x`).
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
