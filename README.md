# Agy-Context-Saver 🛡️

**Model Context Protocol (MCP) Server & Lifecycle Governor for Google Antigravity (Powered by RTK)**

[![npm version](https://img.shields.io/npm/v/agy-context-saver.svg)](https://www.npmjs.com/package/agy-context-saver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/agy-context-saver/)
[![Tests](https://img.shields.io/badge/tests-100%25%20passing-brightgreen.svg)](https://github.com/paragon-ux/agy-context-saver/actions)

`Agy-Context-Saver` is a high-performance lifecycle governor and zero-dependency MCP server purpose-built for **Google Antigravity** (`agy`), paired with **RTK (Rust Token Killer)** for transparent CLI output reduction.

It permanently eliminates session degradation, memory bloat, and context window exhaustion caused by **background task busy-wait polling**, **uncompressed terminal outputs**, and **raw JSON transcript reading**.

---

## Architectural Division of Responsibilities

```text
                         Antigravity Agent
                                |
             +------------------+------------------+
             |                                     |
        run_command                         native inspection /
             |                              lifecycle tools
             v                                     |
        RTK hook                                    |
             |                             +---------+----------+
             v                             |                    |
        RTK execution                  inspection tools      lifecycle
             |                             |                    |
             v                             v                    v
     compact command output          Agy DENY + route      Agy governance
                                           |                    |
                                           v                    v
                                      RTK read/grep/find     Agy MCP
                                           |                    |
                                           +---------+----------+
                                                     |
                                                     v
                                              useful context
```

### RTK Owns:
- Transparent `run_command` rewriting (`rtk rewrite`)
- Shell command output reduction (`git`, `pytest`, `cargo`, `npm`, `docker`, etc.)
- Canonical codebase inspection CLI (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk tree`)
- Focused diagnostic utilities (`rtk err`, `rtk summary`)

### Agy Owns:
- Antigravity lifecycle management & Reactive Wakeup enforcement
- Background task polling governance & 5-strike circuit breaker
- Antigravity internal state protection (`.system_generated/`)
- Zero-JSON Markdown transcript extraction (`read_transcript`, `query_transcript`)
- Subagent delegation formulation (`subagent_brief`)
- Benchmark and evaluation artifact mutation protection

---

## The Core Problems Solved

1. **The Polling Trap**: When shell tasks detach to background jobs (`task-XYZ`), agents waste tokens repeatedly polling `manage_task(Action='status')` or scheduling artificial timers. Agy enforces native **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
2. **The Terminal Bloat Trap**: Routine test runs and git operations dump hundreds of lines of noise into context. RTK compresses these outputs natively before they enter model context.
3. **The Raw Transcript Trap**: Reading `transcript.jsonl` dumps megabytes of raw JSON into context. Agy blocks direct reads of `.system_generated` and provides high-density Markdown streaming tools.
4. **Native Inspection Bypass**: Native inspection tools (`view_file`, `grep_search`, `find_by_name`, `list_dir`) bypass token reduction. Agy hard-routes workspace inspection to RTK's canonical CLI (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`).

---

## Quickstart (Instant Install)

Install and synchronize the governor and RTK across your Antigravity environment:

```bash
# Fastest: one-line registration via npx
npx agy-context-saver install

# Or locally from this repository
npm run setup

# Audit health across all layers at any time
npm run status
```

---

## Key Capabilities

- **Transparent RTK Rewriting**: Native `run_command` calls are automatically rewritten (e.g. `pytest` $\to$ `rtk pytest`) via Antigravity PreToolUse hooks.
- **Canonical Codebase Inspection**:
  - `rtk read <file>`: Read file with intelligent token filtering and line ranges.
  - `rtk grep "<pattern>"`: Compact ripgrep search grouped by file.
  - `rtk find <path>`: Compact file search tree.
  - `rtk ls`: Token-optimized directory listing.
  - `rtk err <cmd>`: Run command and show only errors/warnings.
  - `rtk summary <cmd>`: Run command and produce a 2-line heuristic summary.
- **Antigravity Special Files Safe Harbor**: Direct `view_file` access to `SKILL.md`, brain artifacts, and config files is preserved.
- **Protected Internal State**: Root-based guard prevents reading `.system_generated/` (transcripts, task logs, progress).
- **Session-Wide Lifecycle Ledger**: Polling checks are tracked globally per session; changing task IDs or waiting does not reset governance.
- **Zero-JSON Transcript Streaming**: Stream conversation turns without raw JSON syntax using `read_transcript` and `query_transcript`.

---

## Available MCP Tools

1. `check_context_health`: Diagnoses conversation transcript turn budgets, payload size, RTK status, and polling loops.
2. `subagent_brief`: Formulates scope-isolated prompts for delegated subagents.
3. `read_transcript`: Reads recent conversation history in clean Markdown format (compact/full).
4. `query_transcript`: Forensic filtering and regex search engine for conversation logs.
5. `get_installation_status`: Inspects live Antigravity plugin link, hook, MCP server, tool schemas, and RTK binary.
6. `sync_installation`: Re-verifies and repairs all integration layers in ~25ms.

---

## License

MIT License. Copyright (c) 2026 paragon-ux.
