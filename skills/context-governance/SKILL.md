---
name: context-governance
description: >-
  Use when running shell commands with large outputs, inspecting session transcript health
  via agy-context, preventing repetitive background polling loops, or inspecting codebases with RTK.
---

# Context Governance & Execution Guard (Agy-Context-Saver + RTK)

Agy-Context-Saver and RTK protect session transcript health and LLM attention by transparently compressing command outputs, preventing repetitive background polling loops, and routing codebase and transcript inspection to compact CLI interfaces.

## Architectural Boundaries

- **RTK (Rust Token Killer >= 1.1.0)**: Owns shell command rewriting (`rtk hook antigravity`), terminal output compression, and canonical codebase inspection (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk err`, `rtk summary`).
- **Agy-Context-Saver (v2.0.0 CLI-First)**: Owns Antigravity lifecycle governance, Reactive Wakeup enforcement, transcript forensics (`agy-context transcript ...`), and session integrity.

---

## Unified Codebase & File Inspection

Unbounded full-file `read_file` calls and unoptimized search tools (`grep_search`, `find_by_name`, `list_dir`) bypass token compression and are guarded:

1. **Tier 1 — Compact Search & Discovery (`rtk grep`, `rtk find`, `rtk ls`)**:
   - **Prose / Regex / Symbol Discovery**: Use `rtk grep -rnE "<pattern>" <path>` via `run_command` to locate exact `[StartLine, EndLine]` coordinates. Always specify an explicit path (e.g., `.` or `src/`) to avoid stdin pipe stalls.
   - **Directory / File Discovery**:
     - **Windows**: Use `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`.
     - **POSIX / Linux / macOS**: Use `rtk find <path>`, `rtk ls <path>`, or `rtk tree`.
2. **Tier 2 — Precision Workspace File Reading (`read_file` Hybrid Slice Policy)**:
   - Pass `StartLine` and `EndLine` into `read_file` (bounded slices of `1–150` lines) to preserve exact 1-indexed line numbers for `edit_file` and `write_file` without terminal stdout truncation.
   - Partial slices of `151–800` lines and `ByteOffset`-only unbounded reads are denied; an explicit one-pass full-file audit (`StartLine: 1, EndLine: <TotalLines>`) is permitted only when the file on disk is $\le 800$ lines and $\le 45\text{ KiB}$ (`46,080` bytes).
3. **Tier 3 — RTK Spillover & Diagnostic Boundaries (`rtk read`, `rtk err`, `rtk summary`)**:
   - **Spillovers & Task Logs**: Read `.system_generated/steps/<step>/output.txt` spillovers (or use bounded `read_file` $\le 150$ lines) and completed `tasks/<taskId>.log` files via `rtk read <path>` (`--head-lines` / `--tail-lines`). Never use `rtk read -l minimal|aggressive` or `-m` to derive line numbers for `edit_file` / `write_file`.
   - `rtk err <cmd>`: Runs command and displays only errors/warnings.
   - `rtk summary <cmd>`: Runs command and produces a 2-line technical summary.

*Safe Harbor*: Documented Antigravity special files (`SKILL.md`, brain artifacts, `.gemini/config/`) may be viewed directly via `read_file` without slice bounds, and `.system_generated/steps/<n>/output.txt` supports bounded `read_file` ($\le 150$ lines).

---

## Available `agy-context` CLI Commands

Run `agy-context` directly via `run_command` (installed as an executable shim in `~/.gemini/antigravity/bin/agy-context`; run `agy-context transcript ...` as a single unchained command):

### 1. `agy-context transcript health`
Performs streaming inspection of `transcript.jsonl` to calculate turn budgets, step counts, raw payload size, RTK status, and detect backoff/polling violations.
```bash
agy-context transcript health [--id <conv>] [--json] [--file <path>]
```

### 2. `agy-context transcript read`
Quickly reads recent conversation turns from an Antigravity transcript in clean Markdown format with zero JSON noise.
```bash
agy-context transcript read [--id <conv>] [--mode compact|full] [--last-turns N] [--include-thinking] [--json] [--file <path>]
```

### 3. `agy-context transcript query`
Granular query and forensic filtering engine for transcripts with keyword/regex search, auto-dereferencing of truncated payloads, role filtering (`user`, `assistant`, `subagent`, `tool`, `generic`, `system`, `error`, `all`; defaults to `all`), untruncated `--full-args` / `--field` inspection across ranges, and compact summaries.
- **Zero-Truncation Multi-Step Forensic Pattern**:
  1. `agy-context transcript query --id <conv> --start 0 --end 100 --include-tools --summary` (compact 1-line-per-step index with `[ERROR]` badges)
  2. `agy-context transcript query --id <conv> --start 0 --end 100 --roles assistant --field tool_args` (all untruncated tool call arguments in one call)
  3. `agy-context transcript step --id <conv> --step <N,M,K|N-M> --field content` (batch-extract specific error/tool outputs without 1-by-1 `--step <N>` loops)
```bash
agy-context transcript query [--id <conv>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--include-thinking] [--json] [--file <path>]
```

### 4. `agy-context transcript step`
Surgically dereferences full un-truncated content or specific fields (`content`, `thinking`, `tool_calls`, `tool_args`, `tool_args:<Key>`, `all`) for one step or a single-pass batch/range of steps (`--step 2,8,14`, `--step 2-10`, `--step 2..10`, or `--start 2 --end 10`) from `transcript_full.jsonl`.
```bash
agy-context transcript step --id <conv> (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all] [--json] [--file <path>]
```

### 5. `agy-context status` & `agy-context setup`
Audits or synchronizes the Antigravity 2.0 integration layers (Native Plugin Link, `agy-context-saver` hook in `hooks.json`, `agy-context` CLI shim, RTK `>= 1.1.0`, and legacy MCP cleanup).
```bash
agy-context status
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
```

---

## 3-Layer Governance Invariants

1. **Layer 1: Reactive Lifecycle & Polling Immunity**:
   - Never busy-wait on `manage_task(Action='status')` or rapid polling timers.
   - Stop calling tools and yield the turn for native Reactive Wakeup (`<SYSTEM_MESSAGE>`).
   - Diagnostic status inspections follow exponential backoff: $\min(600, \text{round}(30 \times 2.5^{\text{pollCount}-1}))$.
   - 5 cumulative denials trigger the `force_ask` circuit breaker.
   - For background shell tasks $>15\text{s}$, schedule coordinated watchdog timers: `schedule(DurationSeconds=45, TimerCondition="task-X")` and output a structured Pre-Yield Status Card. Each task watchdog advances the Proportional Backoff level (`30s -> 75s -> 188s -> 469s -> 600s`), blocking repeated 45s/60s timer loops.
   - **Swarm & Subagent Exemption (`swarm_wait` Only)**: Never pair `swarm_wait` or subagents with a one-shot `schedule` timer; `swarm_wait` sleeps at zero token cost and wakes immediately on board posts, and one-shot `schedule` timers polling a swarm or subagent are strictly denied.

2. **Layer 2: Transparent CLI & Codebase Streamlining**:
   - Shell commands transparently rewrite via `rtk hook antigravity` (`rtk git`, `rtk pytest`, `rtk cargo`, etc.).
   - Workspace file inspection follows `rtk grep` / `rtk find` $\to$ bounded `read_file(StartLine, EndLine)` $\to$ `edit_file` / `write_file`, while `rtk read` handles step spillovers and completed task logs.
   - Direct access to `.system_generated/` transcripts is strictly denied; use `agy-context transcript read|query|step|health`.
   - **Log Hygiene (Git CRLF/LF Notice Stripping)**: Repetitive Git line-ending notices (`warning: LF will be replaced by CRLF` / `warning: CRLF will be replaced by LF...`) are non-actionable environment noise. Agy-Context-Saver automatically strips these warning lines across forensic transcript parsers, and agents suppress them at the source (`git -c core.safecrlf=false`) to protect context window tokens.

3. **Layer 3: Synchronous Execution**:
   - Non-daemon `run_command` calls without an explicit `WaitMsBeforeAsync` default to 10,000ms to eliminate unnecessary detachment.

---

## Quick Verification & Health Check

To verify installation health and run test validation:
- **Health Check**: `agy-context status` or `npm run status` (verifies plugin link, hook, CLI shim, RTK `>= 1.1.0`, and 0 legacy MCP configs/schemas).
- **Test Suite**: `npm test` (runs all 11 test suites).
- Detailed verification playbooks and release steps reside in `docs/publishing.md`.
