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

Native Antigravity file and search tools (`view_file`, `grep_search`, `find_by_name`, `list_dir`) bypass token compression and are hard-routed to RTK shell commands:

- `rtk read <file>`: Reads file with intelligent token filtering and line ranges.
- `rtk find <path>`: Compact file search tree and directory listings (cross-platform, works on Windows & POSIX).
- Search commands by platform:
  - **Windows**: Use `rtk rg "<pattern>" .` (explicit target `.` is required to avoid child process stdin pipe stalls) or `rg "<pattern>" .`.
  - **POSIX / Linux / macOS**: Use `rtk grep "<pattern>"` or `rtk rg "<pattern>"`.
- Directory listing by platform:
  - **Windows**: Use `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`. (Avoid `rtk ls` or `rtk tree` on Windows as they rely on POSIX binaries/flags).
  - **POSIX / Linux / macOS**: Use `rtk ls <path>` or `rtk tree`.
- `rtk err <cmd>`: Runs command and displays only errors/warnings.
- `rtk summary <cmd>`: Runs command and produces a 2-line technical summary.

*Safe Harbor*: Documented Antigravity special files (`SKILL.md`, brain artifacts, `.gemini/config/`) may be viewed directly via `view_file`.

---

## Available Agy MCP Tools

### 1. `check_context_health`
Performs streaming inspection of `transcript.jsonl` to calculate turn budgets, step counts, raw payload size, RTK status, and detect busy-polling loops.
- **Parameters**:
  - `transcriptPath` (string, required): Absolute path to `transcript.jsonl`.

### 2. `subagent_brief`
Generates a strictly formatted, scope-isolated prompt for delegating research or debugging to a subagent (`invoke_subagent`).
- **Parameters**:
  - `objective` (string, required): Core investigative or implementation goal.
  - `scopeFiles` (array of strings, optional): Specific file targets.
  - `expectedDeliverable` (string, optional): Expected concise synthesis format.

### 3. `read_transcript`
Quickly reads recent conversation turns from an Antigravity transcript in clean Markdown format with zero JSON noise.
- **Parameters**:
  - `conversationId` (string, required): Conversation UUID or path.
  - `mode` (string, default: "compact"): "compact" or "full".
  - `lastTurns` (number, default: 3): Number of turns to display.

### 4. `query_transcript`
Granular query and forensic filtering engine for transcripts with keyword/regex search and role filtering.
- **Parameters**:
  - `conversationId` (string, required): Conversation UUID or path.
  - `query` (string, optional): Search keyword or regex.
  - `roles` (array, default: ["user", "assistant"]): Filter by role.

### 5. `get_installation_status`
Audits the Antigravity integration layers (Native Plugin Link, Lifecycle Hook in `hooks.json`, MCP Server in `mcp_config.json`, Tool Schemas, and RTK binary/hook).

### 6. `sync_installation`
Re-verifies, repairs, and synchronizes the installation and tool schemas in ~25ms.
- **Parameters**:
  - `checkOnly` (boolean, default: false): Dry-run audit mode.

---

## Core Governance Rules

1. **Reactive Wakeup First**:
   - Never busy-wait on `manage_task(Action='status')` or `schedule` polling timers.
   - Stop calling tools and yield the turn for native Reactive Wakeup (`<SYSTEM_MESSAGE>`).
   - Polling calls across tasks are tracked in a session ledger. 5 cumulative denials trigger `force_ask` autonomous freeze.

2. **Fast Synchronous Execution**:
   - Commands default to `WaitMsBeforeAsync: 10000` to complete synchronously without background detachment.

3. **Protected Antigravity State**:
   - Direct access to `.system_generated/` (transcripts, task logs, scheduler state) is strictly denied. Use Agy MCP transcript tools.

4. **Benchmark Integrity**:
   - Mutating benchmark definitions, prompt templates, or evaluators requires explicit user confirmation.

---

## Zero-Guesswork Testing & Verification Playbook

When validating this framework or reproducing tests, execute these exact steps:

1. **Check Live Registration**:
   ```bash
   npm run status
   # or
   node mcp/index.js status
   ```
   *Expected*: Reports `HEALTHY & ACTIVE 🛡️` across plugin link, hook, MCP server, schemas, and RTK.

2. **Run Full Test Suite**:
   ```bash
   npm test
   ```
   *Expected*: All 5 suites pass (Unit hook tests, MCP protocol tests, E2E probes, live system validation, lifecycle rollback).

3. **Run Targeted Suite Tests**:
   - Governance Hook: `node tests/test-hook.mjs`
   - MCP Protocol & JSON-RPC: `node tests/test-mcp.mjs`
   - E2E Probes: `node tests/test-e2e-probes.mjs`
   - Live System Checks: `node tests/test-installed-verification.mjs`
   - Lifecycle & Rollback: `node tests/test-lifecycle-rollback.mjs`

4. **Verify MCP Tools Inside Antigravity**:
   - `get_installation_status`: Call with `{}` to audit all 4 layers + RTK.
   - `check_context_health`: Call with `{ "transcriptPath": "<path-to-transcript.jsonl>" }`.
   - `read_transcript`: Call with `{ "conversationId": "<uuid>", "lastTurns": 3, "mode": "compact" }`.
   - `query_transcript`: Call with `{ "conversationId": "<uuid>", "query": "<term>", "summaryOnly": true }`.
   - `subagent_brief`: Call with `{ "objective": "<goal>", "scopeFiles": ["..."] }`.

5. **Operational Guardrails**:
   - ❌ Never launch `npm start` or `node mcp/index.js` interactively without stdin redirection (it is a stdio JSON-RPC daemon).
   - ❌ Never loop on `manage_task(Action='status')` or use task watchdog timers (circuit breaker freezes at 5 denials).
   - ❌ Never run `npm run uninstall` as an isolated test (always follow immediately with `npm run setup`).
   - ❌ On Windows, never run `rtk rg` without an explicit directory (e.g. use `rtk rg "pattern" .`).
