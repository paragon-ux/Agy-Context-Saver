# Agy-Context-Saver MCP Server Instructions

## Overview
Agy-Context-Saver is the universal Model Context Protocol server and lifecycle governor for Google Antigravity, paired with RTK (Rust Token Killer) for transparent CLI output reduction.

## Core Rules for Antigravity Agents
1. **Reactive Wakeup (Zero Task Polling)**:
   - When background tasks run, DO NOT call `manage_task(Action='status')` or `schedule` polling timers.
   - Stop calling tools and yield the turn. The system notifies you automatically via `<SYSTEM_MESSAGE>`.
   - Repeated polling triggers an escalating circuit breaker (frozen at 5 denials).
2. **Never Read Internal State Directly**:
   - Access to `.system_generated/` via `view_file` is strictly denied to prevent transcript explosion.
   - Use `read_transcript` or `query_transcript` to inspect conversation history cleanly.
3. **Unified 3-Tier Codebase & File Inspection**:
   - **Tier 1 — Structural Discovery (`waymark_ask` with `plain: true`)**: First locate exact `[StartLine, EndLine]` coordinates via `waymark_ask(..., plain: true)` across all 23 supported formats (code ASTs + `markdown`, `yaml`, `json`, `toml`, `bash`). Always set `plain: true` (~19–466 tokens, zero shell quoting or stdin hazards).
   - **Tier 2 — Precision Workspace File Reading (`view_file` Hybrid Slice Policy)**: Pass the `StartLine` and `EndLine` span from `waymark_ask` into `view_file` (bounded slices of `1–150` lines) to preserve 1-indexed line coordinates for `replace_file_content` and avoid terminal stdout truncation. Partial slices of `151–800` lines are denied; an explicit one-pass full-file audit (`StartLine: 1, EndLine: <TotalLines>`) is permitted only when the file on disk is $\le 800$ lines and $\le 45\text{ KiB}$ (`46,080` bytes).
   - **Tier 3 — RTK Boundaries (`rtk read`, `rtk find`, `rtk rg`)**:
     - **Spillovers & Task Logs**: Read `.system_generated/steps/<step>/output.txt` spillovers and completed `tasks/<taskId>.log` files via `rtk read <path>` (with `--head-lines` / `--tail-lines`). Never use `rtk read -l minimal|aggressive` or `-m` to derive line numbers for edits.
     - **Directory/File Discovery**: Use `rtk find <path>` (Windows & POSIX) or `rtk ls <path>` (POSIX).
     - **Prose / Regex Search**: Use `rtk rg "<pattern>" <path>` (explicit `<path>` required on Windows to avoid stdin stalls) strictly for free-text/regex searches inside body prose or string values when the symbol, heading, or config key name is unknown.

## Available MCP Tools
- `check_context_health`: Diagnoses transcript turn counts, byte payload, and polling loops. Accepts `transcriptPath` or `conversationId`.
- `read_transcript`: Streams recent turns from `transcript.jsonl` or `transcript_full.jsonl` formatted as clean Markdown.
- `query_transcript`: Forensic regex search and filtering engine across transcript steps with optional `summaryOnly: true`, plus surgical step extraction via `stepIndex` and `field`.
- `get_installation_status`: Audits live health of the plugin link, hook, MCP server, tool schemas, and RTK.
- `sync_installation`: Synchronizes and repairs all 4 integration layers in ~25ms.

## Diagnostic & CLI Playbook
- Audit Status: `npm run status` or `node mcp/index.js status`
- Run Test Suite: `npm test`
- CLI Help: `node mcp/index.js --help`
- ⚠️ Warning: Do not run `npm start` or `node mcp/index.js` without subcommands interactively (it is a stdio JSON-RPC server).
