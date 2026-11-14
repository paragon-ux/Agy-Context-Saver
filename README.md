# Agy-Context-Saver 🛡️

**CLI-First Transcript Forensic Engine & Lifecycle Governor for Google Antigravity (Powered by RTK)**

[![npm version](https://img.shields.io/npm/v/agy-context-saver.svg)](https://www.npmjs.com/package/agy-context-saver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/agy-context-saver/)
[![Tests](https://img.shields.io/badge/tests-100%25%20passing-brightgreen.svg)](https://github.com/paragon-ux/agy-context-saver/actions)

`Agy-Context-Saver` is a high-performance lifecycle governor and zero-dependency transcript forensic CLI (`agy-context`) purpose-built for **Google Antigravity** (`agy`), paired with **RTK (Rust Token Killer >= 1.1.0)** for transparent CLI output reduction.

It permanently eliminates session degradation, memory bloat, and context window exhaustion caused by **background task busy-wait polling**, **uncompressed terminal outputs**, and **raw JSON transcript reading**.

---

## Core Value Proposition

| Metric / Capability | Without Governor | With Agy-Context-Saver + RTK |
| :--- | :--- | :--- |
| **Command Output Bloat** | Unlimited raw test dots, ANSI dumps | RTK `>= 1.1.0` transparent reduction via `rtk hook antigravity` (60–90% token savings) |
| **Workspace File Inspection** | Massive uncompressed `read_file` dumps | `rtk grep` / `rtk find` $\to$ bounded `read_file` slices ($\le 150$ lines) $\to$ `edit_file` / `write_file` |
| **Long Command Execution** | Detached after 5s $\to$ busy-wait loop | Synchronous window expanded to 10s $\to$ finishes in-turn |
| **Background Task Monitoring** | Repetitive busy-polling loops | Enforced Reactive Wakeup with 5-strike circuit breaker |
| **Configuration Safety** | Risk of third-party config clobber | Non-destructive preservation of foreign hooks/servers with `.bak` backups |
| **Transcript Review** | Raw JSONL dumped into context | Clean Markdown & forensic queries via `agy-context transcript read\|query\|step\|health` |
| **Runtime Dependencies** | N/A | **Zero** external npm dependencies (100% Node.js stdlib) + native RTK `>= 1.1.0` binary |

---

## Canonical 3-Layer Governance Architecture

1. **Layer 1: Reactive Lifecycle & Polling Immunity**: Replaces destructive busy-polling loops with native Antigravity **Reactive Wakeup**, governed by an exponential Proportional Backoff curve and a 5-strike circuit breaker.
2. **Layer 2: Transparent CLI & Codebase Streamlining**: Intercepts shell execution via PreToolUse hooks (`agy-context-saver`), delegating command rewriting to `rtk hook antigravity`, enforcing bounded `read_file` slices paired with `rtk grep`/`rtk find`, routing spillovers/task logs to `rtk read`, and shielding internal `.system_generated` state in favor of `agy-context transcript ...`.
3. **Layer 3: Synchronous Execution**: Expands default synchronous execution windows to 10s when `WaitMsBeforeAsync` is omitted so routine commands finish in-turn instead of detaching.

> **Subagent tools moved.** `subagent_brief` and squad dispatch now live in the separate [Agy-Squad](https://github.com/paragon-ux/agy-squad) package. Agy-Context-Saver is complete without them, and the two install side by side.

---

## Quickstart (Instant Install)

Install and synchronize the governor, `agy-context` CLI shims, and RTK (`>= 1.1.0`) across your Antigravity environment:

```bash
# Fastest: one-line registration via npx
npx agy-context-saver install

# Or locally from this repository
npm run setup

# Audit health across all layers at any time
npm run status
# or via the installed CLI shim
agy-context status
```

> [!TIP]
> **Enterprise Non-Destructive Guarantee**: Agy-Context-Saver requires **zero external npm dependencies** (100% native Node.js standard library), strictly preserves existing foreign hooks and foreign servers, automatically creates `.bak` configuration backups before mutating, retires legacy `agy-context-saver*` MCP configs/schemas cleanly (`ACS-HOOK-11`), and supports 1-step rollback.

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
    rtk hook antigravity                           |
             |                             +---------+----------+
             v                             |                    |
        RTK execution                  inspection tools      lifecycle
             |                             |                    |
             v                             v                    v
     compact command output          Agy DENY + route      Agy governance
                                           |
                                           v
                                  rtk read/grep/find
                                  agy-context transcript
                                           |
                                           v
                                    useful context
```

### RTK (`>= 1.1.0`) Owns:
- Transparent `run_command` rewriting (`rtk hook antigravity`)
- Shell command output reduction (`git`, `pytest`, `cargo`, `npm`, `docker`, etc.)
- Canonical codebase inspection CLI (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk tree`)
- Focused diagnostic utilities (`rtk err`, `rtk summary`)

### Agy-Context-Saver Owns:
- Antigravity lifecycle management & Reactive Wakeup enforcement
- Background task polling governance & 5-strike circuit breaker
- Antigravity internal state protection (`.system_generated/`)
- Zero-JSON Markdown transcript CLI (`agy-context transcript read|query|step|health`)
- Benchmark and evaluation artifact mutation protection (`edit_file`, `write_file`, shell writes)

---

## The Core Problems Solved

1. **The Polling Trap**: When shell tasks detach to background jobs (`task-XYZ`), agents waste tokens repeatedly polling `manage_task(Action='status')` or scheduling artificial timers. Agy enforces native **Reactive Wakeup** (`<SYSTEM_MESSAGE>`).
2. **The Terminal Bloat Trap**: Routine test runs and git operations dump hundreds of lines of noise into context. RTK `>= 1.1.0` compresses these outputs natively before they enter model context.
3. **The Raw Transcript Trap**: Reading `transcript.jsonl` dumps megabytes of raw JSON into context. Agy blocks direct reads of `.system_generated` and provides the streaming `agy-context transcript` CLI.
4. **Native Inspection Bypass**: Unbounded native inspection tools (`read_file` without slices, `grep_search`, `find_by_name`, `list_dir`) bypass token reduction. Agy enforces bounded `read_file` slices (`StartLine` / `EndLine <= 150`, paired with `rtk grep`) and routes directory/prose search and spillover reads to RTK's canonical CLI (`rtk find`, `rtk grep`, `rtk read`).

---

## Key Capabilities

- **Transparent RTK Rewriting**: Native `run_command` calls are automatically rewritten via `rtk hook antigravity` (with lossy `wc`/`ls`/`diff` reverts and missing-`rg` fallback to `rtk grep`).
- **Unified Codebase & File Inspection**:
  1. **Tier 1 — Compact Search & Discovery (`rtk grep`, `rtk find`, `rtk ls`)**:
     - Prose / Regex / Symbol Search: `rtk grep "<pattern>" <path>` (always pass an explicit target path such as `.` to prevent stdin pipe stalls).
     - Directory listing by platform:
       - **Windows**: `rtk find <path>` or PowerShell `dir` / `Get-ChildItem`.
       - **POSIX / Linux / macOS**: `rtk find <path>`, `rtk ls <path>`, or `rtk tree`.
  2. **Tier 2 — Precision Workspace Reading (`read_file` Hybrid Slice Policy)**: Pass `StartLine` and `EndLine` (`1–150` lines default; or explicit `StartLine: 1, EndLine: <TotalLines>` full-file audit when $\le 800$ lines and $\le 45\text{ KiB}$) into `read_file` to preserve 1-indexed line numbers for `edit_file` and `write_file` without terminal stdout truncation.
  3. **Tier 3 — RTK Spillover & Diagnostic CLI**:
     - `rtk read <path>`: Inspect runtime step spillovers (`.system_generated/steps/<step>/output.txt`) and completed background task logs (`tasks/<taskId>.log`) with `--head-lines` / `--tail-lines`.
     - `rtk err <cmd>`: Run command and show only errors/warnings.
     - `rtk summary <cmd>`: Run command and produce a 2-line heuristic summary.
- **Antigravity Special Files Safe Harbor**: Direct `read_file` access to `SKILL.md`, brain artifacts, and `.gemini/config/` files is preserved, and bounded `read_file` ($\le 150$ lines) is permitted on `.system_generated/steps/<n>/output.txt`.
- **Protected Internal State**: Root-based guard prevents reading `.system_generated/` transcripts and progress logs directly.
- **Session-Wide Lifecycle Ledger**: Polling checks are tracked globally per session; changing task IDs or waiting does not reset governance.
- **Zero-JSON Transcript CLI**: Stream conversation turns, run forensic searches, dereference steps, and check health without MCP overhead using `agy-context transcript`.

---

## Comprehensive Documentation

For complete technical references, architectural specifications, and governance rules, visit our **[Zensical Documentation Site](https://paragon-ux.github.io/agy-context-saver/)**:

- 📖 **[Getting Started & Installation](docs/installation.md)**: Zero-delay setup, native plugin linking, hooks registration, CLI shims, and verification matrix.
- 🏗️ **[Architecture & Internals](docs/architecture.md)**: Closed Execution Topology, RTK separation of concerns, and the Four Non-Fragile Architectural Pillars.
- 🛡️ **[Lifecycle Governance & Hooks](docs/governance.md)**: Proportional Backoff curve, Reactive Wakeup invariants, and the 5-strike circuit breaker.
- 🧰 **[CLI Reference](docs/tools.md)**: Complete specifications for `agy-context transcript` commands and diagnostic utilities.
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
agy-context status
```
*Confirms that the Native Plugin Link, `agy-context-saver` Hook, `agy-context` CLI shim, RTK (`>= 1.1.0`), and MCP cleanup (`0` duplicate MCP configs/schemas) are healthy.*

### 2. Run Complete Automated Test Suite
```bash
npm test
```
*Runs all 11 test suites (`tests/test-hook.mjs`, `tests/test-transcript.mjs`, `tests/test-rtk-integration.mjs`, `tests/test-output-governance.mjs`, `tests/test-e2e-probes.mjs`, `tests/test-performance-probes.mjs`, `tests/test-installed-verification.mjs`, `tests/test-lifecycle-rollback.mjs`, `tests/test-check-only-readonly.mjs`, `tests/test-malformed-config-preservation.mjs`, and `tests/test-rtk-ledger-fresh-install.mjs`).*

### 3. Run Targeted Tests Individually
```bash
# Governance hook unit tests
node tests/test-hook.mjs

# Transcript engine, CLI & deprecated MCP wrapper tests
node tests/test-transcript.mjs

# Live RTK >= 1.1.0 hook antigravity contract tests
node tests/test-rtk-integration.mjs

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

### 4. Use `agy-context` CLI Directly
- `agy-context transcript health [--id <uuid>] [--json]`
- `agy-context transcript read [--id <uuid>] [--last-turns 3] [--mode compact|full]`
- `agy-context transcript query [--id <uuid>] [--query "<term>"] [--summary]`
- `agy-context transcript step --id <uuid> --step <N> [--field content|thinking|tool_calls|tool_args|all]`

### 5. Testing Pitfalls & Anti-Patterns to Avoid
- ❌ **Do NOT loop on `manage_task(Action='status')`**: Polling triggers the session ledger circuit breaker at 5 cumulative denials. Rely on native Reactive Wakeup (`<SYSTEM_MESSAGE>`).
- ❌ **Do NOT run `npm run uninstall` as a standalone check**: It unregisters the live hook and CLI shims. If run, immediately re-run `npm run setup`.
- ❌ **Do NOT omit the directory in `rtk grep`**: Always run `rtk grep "<pattern>" .` to avoid stdin pipe blocking.
- ❌ **Do NOT chain `agy-context transcript ...` with `&&`, `|`, `;`, or redirects**: Invoke it as a single unchained command.

---

## `agy-context` CLI Reference

* **Transcript Forensics (`agy-context transcript ...`)**:
  1. `agy-context transcript health`: Diagnoses conversation transcript turn budgets, payload size, RTK status, and backoff/polling compliance.
  2. `agy-context transcript read`: Reads recent conversation history in clean Markdown format (`--mode compact|full`, `--last-turns N`, `--include-thinking`).
  3. `agy-context transcript query`: Forensic filtering, regex search across compact + truncated full steps, role filtering (`user,assistant,subagent,tool,error,all`), and `--summary` mode.
  4. `agy-context transcript step`: Surgical single-step dereferencing (`--step N`, `--field content|thinking|tool_calls|tool_args|tool_args:<Key>|all`) from `transcript_full.jsonl`.
* **Lifecycle Management**:
  - `agy-context status`: Audits plugin link, `agy-context-saver` hook, `agy-context` CLI shim, RTK `>= 1.1.0`, and MCP cleanup.
  - `agy-context setup [--check] [--allow-degraded]`: Synchronizes or preflight-checks installation layers.
  - `agy-context uninstall [--restore-backups]`: Removes plugin link, hook, CLI shims, and legacy MCP configs/schemas.
* **Streamlined Output Inspection**:
  - **Runtime Step Spillovers** (`.system_generated/steps/<step>/output.txt`): Inspected via canonical `rtk read <path>` or bounded `read_file` ($\le 150$ lines).
  - **Completed Background Task Logs**: Inspected via `rtk read tasks/<taskId>.log` (lifecycle-gated in the PreToolUse hook; strictly blocked under Proportional Backoff while running, allowed once completed).

---

## License

MIT License. Copyright (c) 2026 paragon-ux.
