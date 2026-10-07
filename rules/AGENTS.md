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
  - `rtk grep "<pattern>"`: Compact ripgrep search grouped by file.
  - `rtk find <path>`: Compact file search tree.
  - `rtk ls`: Token-optimized directory listing.
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
