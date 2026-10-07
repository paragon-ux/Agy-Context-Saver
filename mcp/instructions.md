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
3. **Platform-Aware Codebase Inspection**:
   - **Windows**: Use `rtk read <file>`, `rtk find <path>`, and `rtk rg "<pattern>" .` (the trailing `.` is required to avoid stdin stalls).
   - **POSIX**: Use `rtk read <file>`, `rtk ls <path>`, and `rtk grep "<pattern>"` or `rtk rg "<pattern>"`.

## Available MCP Tools
- `check_context_health`: Diagnoses transcript turn counts, byte payload, and polling loops. Accepts `transcriptPath` or `conversationId`.
- `subagent_brief`: Generates scope-isolated instructions for delegated subagents to prevent parent context bloat.
- `read_transcript`: Streams recent turns from `transcript.jsonl` or `transcript_full.jsonl` formatted as clean Markdown.
- `query_transcript`: Forensic regex search and filtering engine across transcript steps with optional `summaryOnly: true`.
- `get_installation_status`: Audits live health of the plugin link, hook, MCP server, tool schemas, and RTK.
- `sync_installation`: Synchronizes and repairs all 4 integration layers in ~25ms.

## Diagnostic & CLI Playbook
- Audit Status: `npm run status` or `node mcp/index.js status`
- Run Test Suite: `npm test`
- CLI Help: `node mcp/index.js --help`
- ⚠️ Warning: Do not run `npm start` or `node mcp/index.js` without subcommands interactively (it is a stdio JSON-RPC server).
