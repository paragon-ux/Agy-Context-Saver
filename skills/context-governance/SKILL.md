---
name: context-governance
description: >-
  Use when running shell commands with large outputs, inspecting session transcript health,
  preventing repetitive background polling loops, inspecting codebases with RTK, or delegating heavy research to subagents.
---

# Context Governance & Execution Guard (Agy-Context-Saver + RTK)

Agy-Context-Saver and RTK protect session transcript health and LLM attention by transparently compressing command outputs, preventing repetitive background polling loops, routing native inspection to compact CLI interfaces, and offloading deep research to sandboxed subagents.

## Architectural Boundaries

- **RTK (Rust Token Killer)**: Owns shell command rewriting, terminal output compression, and canonical codebase inspection (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk err`, `rtk summary`).
- **Agy-Context-Saver**: Owns Antigravity lifecycle governance, Reactive Wakeup enforcement, transcript forensics, and session integrity.

---

## Codebase Inspection via RTK

Unbounded full-file `view_file` calls and unoptimized search tools (`grep_search`, `find_by_name`, `list_dir`) bypass token compression and are guarded:

- `view_file` with bounded slices (`StartLine` and `EndLine`, max 150 lines): **Preferred for reading files**—returns exact 1-indexed line numbers without terminal stdout truncation.
- `rtk find <path>`: Compact file search tree and directory listings (cross-platform, works on Windows & POSIX).
- Search commands by platform:
  - **Windows**: Use `rtk rg "<pattern>" .` (explicit target `.` is required to avoid child process stdin pipe stalls) or `rg "<pattern>" .`.
  - **POSIX / Linux / macOS**: Use `rtk grep "<pattern>"` or `rtk rg "<pattern>"`.
- Directory listing by platform:
  - **Windows**: Use `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`. (Avoid `rtk ls` or `rtk tree` on Windows as they rely on POSIX binaries/flags).
  - **POSIX / Linux / macOS**: Use `rtk ls <path>` or `rtk tree`.
- `rtk err <cmd>`: Runs command and displays only errors/warnings.
- `rtk summary <cmd>`: Runs command and produces a 2-line technical summary.

*Safe Harbor*: Documented Antigravity special files (`SKILL.md`, brain artifacts, `.gemini/config/`) may be viewed directly via `view_file` without slice bounds.

---

## Available Agy MCP Tools

### 1. `check_context_health`
Performs streaming inspection of `transcript.jsonl` to calculate turn budgets, step counts, raw payload size, RTK status, and detect busy-polling loops.
- **Parameters**:
  - `transcriptPath` (string, required): Absolute path to `transcript.jsonl`.

### 2. `subagent_brief`
Generates a strictly formatted, scope-isolated prompt for delegating research or debugging to a subagent (`invoke_subagent`). Enforces the **Pointer-Over-Wire (POW)** protocol: deliverables exceeding 1 KB must be written to workspace scratch files (e.g. `scratch/<task>_findings.md`), transmitting only an executive summary, scoreboard, and clickable `file:///` link in-band.
- **Parameters**:
  - `objective` (string, required): Core investigative or implementation goal.
  - `role` (string, optional): Subagent role / title.
  - `scopeFiles` (array of strings, optional): Specific file targets.
  - `expectedDeliverable` (string, optional): Expected concise synthesis format.
  - `subagents` (array, optional): Batch of subagent objects for multi-role delegation.

### 3. `read_transcript`
Quickly reads recent conversation turns from an Antigravity transcript in clean Markdown format with zero JSON noise.
- **Parameters**:
  - `conversationId` (string, required): Conversation UUID or path.
  - `mode` (string, default: "compact"): "compact" or "full".
  - `lastTurns` (number, default: 3): Number of turns to display.

### 4. `query_transcript`
Granular query and forensic filtering engine for transcripts with keyword/regex search, auto-dereferencing of truncated payloads, and surgical step projection.
- **Parameters**:
  - `conversationId` (string, required): Conversation UUID or path.
  - `query` (string, optional): Search keyword or regex.
  - `roles` (array, default: ["user", "assistant"]): Filter by role.
  - `stepIndex` (number, optional): Specific step to dereference from `transcript_full.jsonl`.
  - `field` (string, optional): Field projection (`"content"`, `"thinking"`, `"tool_calls"`).

### 5. `get_installation_status`
Audits the Antigravity integration layers (Native Plugin Link, Lifecycle Hook in `hooks.json`, MCP Server in `mcp_config.json`, Tool Schemas, and RTK binary/hook).

### 6. `sync_installation`
Re-verifies, repairs, and synchronizes the installation and tool schemas in ~25ms.
- **Parameters**:
  - `checkOnly` (boolean, default: false): Dry-run audit mode.

---

## 3-Layer Governance Invariants

1. **Layer 1: Reactive Lifecycle & Polling Immunity**:
   - Never busy-wait on `manage_task(Action='status')` or rapid polling timers.
   - Stop calling tools and yield the turn for native Reactive Wakeup (`<SYSTEM_MESSAGE>`).
   - Diagnostic status inspections follow exponential backoff: $\min(600, \text{round}(30 \times 2.5^{\text{pollCount}-1}))$.
   - 5 cumulative denials trigger the `force_ask` circuit breaker.
   - For operations $>15\text{s}$, schedule coordinated watchdog timers: `schedule(DurationSeconds=45, TimerCondition="task-X")` and output a structured Pre-Yield Status Card.

2. **Layer 2: Transparent CLI & Codebase Streamlining**:
   - Shell commands transparently rewrite via RTK (`rtk git`, `rtk pytest`, `rtk cargo`, etc.).
   - Codebase inspection is hard-routed to `rtk read`, `rtk find`, and `rtk rg "<pattern>" .`.
   - Direct access to `.system_generated/` is strictly denied; use `read_transcript` and `query_transcript`.

3. **Layer 3: Orchestration, Delegation & Pointer-Over-Wire (POW)**:
   - Synchronous wait window expands to 10,000ms to eliminate unnecessary detachment.
   - Heavy exploratory work is delegated to subagents (`invoke_subagent`).
   - Subagents strictly follow Pointer-Over-Wire: write reports $>1\text{ KB}$ to disk; transmit only summary, scoreboard, and clickable file link.

---

## Quick Verification & Health Check

To verify installation health and run test validation:
- **Health Check**: `npm run status` (verifies plugin link, hook, MCP config, schemas, RTK).
- **Test Suite**: `npm test` (runs all 8 test suites).
- Detailed verification playbooks and release steps reside in `docs/publishing.md`.
