---
name: context-governance
description: >-
  Use when running shell commands with large outputs, inspecting session transcript health,
  preventing repetitive background polling loops, or inspecting codebases with RTK.
---

# Context Governance & Execution Guard (Agy-Context-Saver + RTK)

Agy-Context-Saver and RTK protect session transcript health and LLM attention by transparently compressing command outputs, preventing repetitive background polling loops, and routing native inspection to compact CLI interfaces.

## Architectural Boundaries

- **RTK (Rust Token Killer)**: Owns shell command rewriting, terminal output compression, and canonical codebase inspection (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk err`, `rtk summary`).
- **Agy-Context-Saver**: Owns Antigravity lifecycle governance, Reactive Wakeup enforcement, transcript forensics, and session integrity.

---

## Unified 3-Tier Codebase & File Inspection

Unbounded full-file `view_file` calls and unoptimized search tools (`grep_search`, `find_by_name`, `list_dir`) bypass token compression and are guarded:

1. **Tier 1 — Structural Discovery (`waymark_ask` with `plain: true`)**:
   - Locate exact `[StartLine, EndLine]` coordinates via `waymark_ask(..., plain: true)` across all 23 supported formats (code ASTs + `markdown`, `yaml`, `json`, `toml`, `bash`). Always set `plain: true` (~19–466 tokens, zero shell quoting or stdin hazards).
2. **Tier 2 — Precision Workspace File Reading (`view_file` Hybrid Slice Policy)**:
   - Pass `StartLine` and `EndLine` from `waymark_ask` into `view_file` (bounded slices of `1–150` lines) to preserve exact 1-indexed line numbers for `replace_file_content` without terminal stdout truncation. Partial slices of `151–800` lines are denied; an explicit one-pass full-file audit (`StartLine: 1, EndLine: <TotalLines>`) is permitted only when the file on disk is $\le 800$ lines and $\le 45\text{ KiB}$ (`46,080` bytes).
3. **Tier 3 — RTK Boundaries (`rtk read`, `rtk find`, `rtk rg`, `rtk err`, `rtk summary`)**:
   - **Spillovers & Task Logs**: Read `.system_generated/steps/<step>/output.txt` spillovers and completed `tasks/<taskId>.log` files via `rtk read <path>` (`--head-lines` / `--tail-lines`). Never use `rtk read -l minimal|aggressive` or `-m` to derive line numbers for edits.
   - **Directory / File Discovery**:
     - **Windows**: Use `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`. (Avoid `rtk ls` or `rtk tree` on Windows as they rely on POSIX binaries/flags).
     - **POSIX / Linux / macOS**: Use `rtk find <path>`, `rtk ls <path>`, or `rtk tree`.
   - **Prose / Regex Search (when symbol, heading, or config key is unknown)**:
     - **Windows**: Use `rtk rg "<pattern>" .` (explicit target `.` is required to avoid child process stdin pipe stalls) or `rg "<pattern>" .`.
     - **POSIX / Linux / macOS**: Use `rtk grep "<pattern>"` or `rtk rg "<pattern>"`.
   - `rtk err <cmd>`: Runs command and displays only errors/warnings.
   - `rtk summary <cmd>`: Runs command and produces a 2-line technical summary.

*Safe Harbor*: Documented Antigravity special files (`SKILL.md`, brain artifacts, `.gemini/config/`) may be viewed directly via `view_file` without slice bounds.

---

## Available Agy MCP Tools

### 1. `check_context_health`
Performs streaming inspection of `transcript.jsonl` to calculate turn budgets, step counts, raw payload size, RTK status, and detect busy-polling loops.
- **Parameters**:
  - `transcriptPath` (string, required): Absolute path to `transcript.jsonl`.

### 2. `read_transcript`
Quickly reads recent conversation turns from an Antigravity transcript in clean Markdown format with zero JSON noise.
- **Parameters**:
  - `conversationId` (string, required): Conversation UUID or path.
  - `mode` (string, default: "compact"): "compact" or "full".
  - `lastTurns` (number, default: 3): Number of turns to display.

### 3. `query_transcript`
Granular query and forensic filtering engine for transcripts with keyword/regex search, auto-dereferencing of truncated payloads, and surgical step projection.
- **Parameters**:
  - `conversationId` (string, required): Conversation UUID or path.
  - `query` (string, optional): Search keyword or regex.
  - `roles` (array, default: ["user", "assistant"]): Filter by role (`"user"`, `"assistant"`, `"subagent"`, `"tool"`, `"error"`, `"all"`).
  - `stepIndex` (number, optional): Specific step to dereference from `transcript_full.jsonl`.
  - `field` (string, optional): Field projection (`"content"`, `"thinking"`, `"tool_calls"`).

### 4. `get_installation_status`
Audits the Antigravity integration layers (Native Plugin Link, Lifecycle Hook in `hooks.json`, MCP Server in `mcp_config.json`, Tool Schemas, and RTK binary/hook).

### 5. `sync_installation`
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
   - Workspace file inspection follows `waymark_ask(..., plain: true)` $\to$ bounded `view_file(StartLine, EndLine)`, while `rtk read` handles step spillovers and completed task logs, and `rtk find` / `rtk rg "<pattern>" .` handle directory and free-text search.
   - Direct access to `.system_generated/` is strictly denied; use `read_transcript` and `query_transcript`.
   - **Log Hygiene (Git CRLF/LF Notice Stripping)**: Repetitive Git line-ending notices (`warning: LF will be replaced by CRLF` / `warning: CRLF will be replaced by LF...`) are non-actionable environment noise. Agy-Context-Saver automatically strips these warning lines across forensic transcript parsers, and agents suppress them at the source (`git -c core.safecrlf=false`) to protect context window tokens.

3. **Layer 3: Synchronous Execution**:
   - Synchronous wait window expands to 10,000ms to eliminate unnecessary detachment.

---

## Quick Verification & Health Check

To verify installation health and run test validation:
- **Health Check**: `npm run status` (verifies plugin link, hook, MCP config, schemas, RTK).
- **Test Suite**: `npm test` (runs all 10 test suites).
- Detailed verification playbooks and release steps reside in `docs/publishing.md`.
