# Agy-Context-Saver 🛡️

**Model Context Protocol (MCP) Server & Lifecycle Governor for Google Antigravity (Powered by RTK)**

[![npm version](https://img.shields.io/npm/v/agy-context-saver.svg)](https://www.npmjs.com/package/agy-context-saver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/agy-context-saver/)
[![Tests](https://img.shields.io/badge/tests-100%25%20passing-brightgreen.svg)](https://github.com/paragon-ux/agy-context-saver/actions)

`Agy-Context-Saver` is a high-performance lifecycle governor and zero-dependency MCP server purpose-built for **Google Antigravity** (`agy`), paired with **RTK (Rust Token Killer)** for transparent CLI output reduction.

It permanently eliminates session degradation, memory bloat, and context window exhaustion caused by **background task busy-wait polling**, **uncompressed terminal outputs**, and **raw JSON transcript reading**.

---

## Core Value Proposition

| Metric / Capability | Without Governor | With Agy-Context-Saver + RTK |
| :--- | :--- | :--- |
| **Command Output Bloat** | Unlimited raw test dots, ANSI dumps | RTK transparent reduction (60–90% token savings) |
| **Workspace File Inspection** | Massive uncompressed view_file dumps | Compact `rtk read`, `rtk grep`, `rtk find` |
| **Long Command Execution** | Detached after 5s $\to$ busy-wait loop | Synchronous window expanded to 10s $\to$ finishes in-turn |
| **Background Task Monitoring** | Repetitive busy-polling loops | Enforced Reactive Wakeup with 5-strike circuit breaker |
| **Configuration Safety** | Risk of third-party config clobber | Non-destructive preservation of foreign hooks/MCP with `.bak` backups |
| **Transcript Review** | Raw JSONL dumped into context | Clean human-readable Markdown via `read_transcript` |
| **Runtime Dependencies** | N/A | **Zero** external npm dependencies (100% Node.js stdlib) + native RTK binary |

---

## Canonical 3-Layer Governance Architecture

1. **Layer 1: Reactive Lifecycle & Polling Immunity**: Replaces destructive busy-polling loops with native Antigravity **Reactive Wakeup**, governed by an exponential Proportional Backoff curve and a 5-strike circuit breaker.
2. **Layer 2: Transparent CLI & Codebase Streamlining**: Intercepts shell execution via PreToolUse hooks, transparently rewriting commands to RTK (`rtk git`, `rtk pytest`), hard-routing workspace searches to `rtk read`/`find`/`rg`, and shielding internal `.system_generated` state.
3. **Layer 3: Synchronous Execution**: Expands synchronous execution windows to 10s so routine commands finish in-turn instead of detaching.

> **Subagent tools moved.** `subagent_brief` and squad dispatch now live in the separate [Agy-Squad](https://github.com/paragon-ux/agy-squad) package (under construction). Agy-Context-Saver is complete without them, and the two will install side by side.

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

> [!TIP]
> **Enterprise Non-Destructive Guarantee**: Agy-Context-Saver requires **zero external npm dependencies** (100% native Node.js standard library), strictly preserves existing foreign hooks (e.g. `waymark-continuity`) and foreign MCP servers, automatically writes atomic `.bak` configuration backups, and supports clean 1-step rollback.

> [!NOTE]
> **RTK Default Configuration Notice**: To protect agent context and command execution from unprompted marketing banners (`[rtk] /!\ No hook installed...`), `Agy-Context-Saver` standardizes `suppress_hook_warning = true` in RTK's user configuration (`%APPDATA%\rtk\config.toml` on Windows / `~/.config/rtk/config.toml` on POSIX) during installation. Existing user configurations are safely preserved. See [RTK Support Matrix](docs/RTK-SUPPORT-MATRIX.md#rtk-configuration-standardization--default-modifications).

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
- Benchmark and evaluation artifact mutation protection

---

## The Core Problems Solved

1. **The Polling Trap**: When shell tasks detach to background jobs (`task-XYZ`), agents waste tokens repeatedly polling `manage_task(Action='status')` or scheduling artificial timers. Agy enforces native **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
2. **The Terminal Bloat Trap**: Routine test runs and git operations dump hundreds of lines of noise into context. RTK compresses these outputs natively before they enter model context.
3. **The Raw Transcript Trap**: Reading `transcript.jsonl` dumps megabytes of raw JSON into context. Agy blocks direct reads of `.system_generated` and provides high-density Markdown streaming tools.
4. **Native Inspection Bypass**: Native inspection tools (`view_file`, `grep_search`, `find_by_name`, `list_dir`) bypass token reduction. Agy hard-routes workspace inspection to RTK's canonical CLI (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`).

---

## Key Capabilities

- **Transparent RTK Rewriting**: Native `run_command` calls are automatically rewritten (e.g. `pytest` $\to$ `rtk pytest`) via Antigravity PreToolUse hooks.
- **Canonical Codebase Inspection**:
  - `rtk read <file>`: Read file with intelligent token filtering and line ranges.
  - `rtk find <path>`: Compact file search tree and directory listing (cross-platform, works on Windows & POSIX).
  - Search by platform:
    - **Windows**: `rtk rg "<pattern>" .` (explicit target `.` prevents child process stdin stalls) or `rg "<pattern>" .`.
    - **POSIX / Linux / macOS**: `rtk grep "<pattern>"` or `rtk rg "<pattern>"`.
  - Directory listing by platform:
    - **Windows**: `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`. (Avoid `rtk ls` / `rtk tree` on Windows as they rely on POSIX binaries/flags).
    - **POSIX / Linux / macOS**: `rtk ls <path>` or `rtk tree`.
  - `rtk err <cmd>`: Run command and show only errors/warnings.
  - `rtk summary <cmd>`: Run command and produce a 2-line heuristic summary.
- **Antigravity Special Files Safe Harbor**: Direct `view_file` access to `SKILL.md`, brain artifacts, and config files is preserved.
- **Protected Internal State**: Root-based guard prevents reading `.system_generated/` (transcripts, task logs, progress).
- **Session-Wide Lifecycle Ledger**: Polling checks are tracked globally per session; changing task IDs or waiting does not reset governance.
- **Zero-JSON Transcript Streaming**: Stream conversation turns without raw JSON syntax using `read_transcript` and `query_transcript`.

---

## Comprehensive Documentation

For complete technical references, architectural specifications, and governance rules, visit our **[Zensical Documentation Site](https://paragon-ux.github.io/agy-context-saver/)**:

- 📖 **[Getting Started & Installation](docs/installation.md)**: Zero-delay setup, native plugin linking, hooks registration, and verification matrix.
- 🏗️ **[Architecture & Internals](docs/architecture.md)**: Closed Execution Topology, RTK separation of concerns, and the Four Non-Fragile Architectural Pillars.
- 🛡️ **[Lifecycle Governance & Hooks](docs/governance.md)**: Proportional Backoff curve, Reactive Wakeup invariants, and the 5-strike circuit breaker.
- 🧰 **[MCP Tools & CLI Reference](docs/tools.md)**: Complete specifications for all 5 canonical autonomous MCP tools, slash commands, and diagnostic utilities.
- 🔬 **[Forensic & Output Inspection](docs/architecture.md#6-output-governance-spillover-safe-harbor-0-new-tools)**: Ephemeral tool spillover resolution, and post-mortem task retrieval.
- 🚀 **[Publishing & Verification Playbook](docs/publishing.md)**: Clean-room test runs, release procedures, and multi-suite verification matrix.
- 🗺️ **[Product Roadmap](docs/roadmap.md)**: Phased strategic roadmap focusing on affordable and reliable multi-agent workflows across general tasks.

---

## Local Documentation Server

Build or serve the documentation locally using **Zensical**:

```bash
# Build static documentation site
zensical build

# Serve live preview server
zensical serve
```

---

## Zero-Guesswork Testing & Verification Playbook

To cleanly test every layer of the framework without guesswork or interactive stalls:

### 1. Audit Live Registration
```bash
npm run status
# or
node mcp/index.js status
```
*Confirms that all 4 integration layers (Plugin link, Lifecycle Hook, MCP Server, Schemas) and RTK are active.*

### 2. Run Complete Automated Test Suite
```bash
npm test
```
*Runs all 10 test suites (hook governance, MCP protocol, output inspection governance, E2E probes, performance probes, installed verification, lifecycle rollback, check-only read-only safety, malformed configuration preservation, and RTK ledger fresh install verification).*

### 3. Run Targeted Tests Individually
```bash
# Governance hook unit tests (27 closed-topology tests)
node tests/test-hook.mjs

# MCP server protocol & method tests
node tests/test-mcp.mjs

# Output inspection & lifecycle gating tests
node tests/test-output-governance.mjs

# End-to-end edge case & probe tests
node tests/test-e2e-probes.mjs

# Performance, streaming & memory probes
node tests/test-performance-probes.mjs

# Live installed environment verification
node tests/test-installed-verification.mjs

# Clean install/uninstall/restore lifecycle test
node tests/test-lifecycle-rollback.mjs

# Check-only read-only isolation regression test
node tests/test-check-only-readonly.mjs

# Malformed config preservation fail-closed regression test
node tests/test-malformed-config-preservation.mjs

# RTK ledger & fresh install verification test
node tests/test-rtk-ledger-fresh-install.mjs
```

### 4. Test MCP Tools from Antigravity Agent
- `get_installation_status`: Call with `{}` to audit all 4 layers + RTK.
- `check_context_health`: Call with `{ "transcriptPath": "<path-to-transcript.jsonl>" }`.
- `read_transcript`: Call with `{ "conversationId": "<uuid>", "lastTurns": 3, "mode": "compact" }`.
- `query_transcript`: Call with `{ "conversationId": "<uuid>", "query": "<term>", "summaryOnly": true }`.

### 5. Testing Pitfalls & Anti-Patterns to Avoid
- ❌ **Do NOT run `npm start` or `node mcp/index.js` interactively**: It starts the stdio JSON-RPC daemon and waits indefinitely on `stdin`.
- ❌ **Do NOT loop on `manage_task(Action='status')`**: Polling triggers the session ledger circuit breaker at 5 cumulative denials. Rely on native Reactive Wakeup (`<SYSTEM_MESSAGE>`).
- ❌ **Do NOT run `npm run uninstall` as a standalone check**: It unregisters the live hook. If run, immediately re-run `npm run setup`.
- ❌ **On Windows, do NOT omit the directory in `rtk rg`**: Always run `rtk rg "<pattern>" .` to avoid stdin pipe blocking.

---

## MCP Tools & Slash Commands

* **User Slash Command (`/mcp:...`)**:
  - `/mcp:agy-context-saver:context_shield`: Injects 3-layer governance rules and RTK standards into any session with one click. *(MCP Prompts appear in your chat autocomplete menu; MCP Tools are called autonomously by the agent).*
* **Agent MCP Tools**:
  1. `check_context_health`: Diagnoses conversation transcript turn budgets, payload size, RTK status, and polling loops.
  2. `read_transcript`: Reads recent conversation history in clean Markdown format (compact/full).
  3. `query_transcript`: Forensic filtering, regex search engine, and surgical single-step dereferencing (`stepIndex`, `field`) from full transcripts.
  4. `get_installation_status`: Inspects live Antigravity plugin link, hook, MCP server, tool schemas, and RTK binary.
  5. `sync_installation`: Re-verifies and repairs all integration layers in ~25ms.

* **Streamlined Output Inspection (0 New Tools)**:
  - **Runtime Step Spillovers** (`.system_generated/steps/<step>/output.txt`): Inspected via canonical `rtk read <path>` (safe-harbored in the PreToolUse hook; native `view_file` calls automatically route to `rtk read`).
  - **Completed Background Task Logs**: Inspected via `rtk read tasks/<taskId>.log` (lifecycle-gated in the PreToolUse hook; strictly blocked under Proportional Backoff while running, allowed once completed).

---

## License

MIT License. Copyright (c) 2026 paragon-ux.
