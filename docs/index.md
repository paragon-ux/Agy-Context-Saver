# Overview & Motivation

**Agy-Context-Saver** is an open-source Model Context Protocol (MCP) server and lifecycle governor engineered specifically for **Google Antigravity** (`agy`), paired with **RTK (Rust Token Killer)** for transparent CLI output reduction.

It eliminates session degradation, memory leaks, and context window exhaustion caused by **background task busy-wait polling**, **terminal output bloat**, **native inspection bypasses**, and **raw transcript reading**.

---

## Quickstart

Install and activate the governor across your Antigravity environment in seconds:

=== "NPX (Recommended)"
    ```bash
    npx agy-context-saver install
    ```

=== "Local Setup"
    ```bash
    npm run setup
    ```

=== "Audit Status"
    ```bash
    npm run status
    ```

---

## Why Agy-Context-Saver + RTK?

`Agy-Context-Saver` leverages the **open Model Context Protocol (MCP)** specification alongside native Antigravity lifecycle hooks, integrating seamlessly with RTK:

- **RTK owns command optimization**: Supported shell commands are transparently rewritten via `rtk rewrite` before execution, yielding 60–90% token reduction across git, pytest, cargo, npm, docker, and linters.
- **Agy owns Antigravity integrity**: Hard-routes native inspection tools to canonical RTK shell commands, enforces Reactive Wakeup, blocks direct access to internal `.system_generated` state, and provides zero-JSON Markdown transcript extraction.

Any developer running Antigravity on macOS, Linux, or Windows can install and activate the governor immediately without external cloud dependencies.

---

## The Core Problems Solved

```mermaid
graph TD
    subgraph Problem1["1. Background Polling Trap"]
        A1["Long-running Command"] --> B1["Detached to Background Task"]
        B1 --> C1["Agent polls manage_task('status')"]
        C1 --> D1["Context inflated by 50-100 KB/min"]
        D1 --> C1
    end

    subgraph Problem2["2. Raw Terminal & JSON Bloat"]
        A2["Verbose Shell / Transcript Reads"] --> B2["Raw ASCII dots, dumps, JSON noise"]
        B2 --> C2["Context window exhausted"]
        C2 --> D2["Compaction amnesia & CoT degradation"]
    end
```

### 1. The Background Task Polling Trap
When an agent initiates a shell command exceeding `WaitMsBeforeAsync` (~5 seconds), Antigravity detaches the process into a background task (`task-XYZ`).
- **The Anti-Pattern**: Large Language Models exhibit an innate busy-waiting bias: they repeatedly invoke `manage_task(Action='status')` or schedule short timers rather than yielding execution to the native **Reactive Wakeup** system.
- **The Consequence**: Transcripts bloat rapidly, pushing critical user instructions and architectural constraints out of the attention window, degrading model reasoning and causing session stalls.
- **The Solution**: Agy's closed session ledger blocks repeated polling and enforces native Reactive Wakeup (`<SYSTEM_MESSAGE>`).

### 2. The Terminal Output Bloat Trap
- **The Problem**: Routine test runs, linters, and build commands dump thousands of repetitive pass lines and progress indicators into the transcript.
- **The Solution**: RTK transparently intercepts and optimizes commands via PreToolUse hooks, collapsing passes and preserving failures.

### 3. The Native Inspection Bypass Trap
- **The Problem**: Native file and search tools (`view_file`, `grep_search`, `find_by_name`, `list_dir`) bypass RTK command optimization.
- **The Solution**: Agy hard-routes workspace inspection to canonical RTK CLI interfaces (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`).

### 4. The Raw Transcript Reading Trap
- **The Problem**: Direct `view_file` on `.system_generated/logs/transcript.jsonl` floods working memory with raw JSON syntax.
- **The Solution**: Agy blocks direct reads of `.system_generated` by root and provides streaming Markdown tools (`read_transcript`, `query_transcript`).

---

## Core Value Proposition

| Metric / Feature | Without Governor | With Agy-Context-Saver + RTK |
| :--- | :--- | :--- |
| **Command Output Bloat** | Unlimited raw test dots, ANSI dumps | RTK transparent reduction (60–90% token savings) |
| **Workspace File Inspection** | Massive uncompressed view_file dumps | Compact `rtk read`, `rtk grep`, `rtk find` |
| **Long Command Execution** | Detached after 5s $\to$ busy-wait loop | Synchronous window expanded to 10s $\to$ finishes in-turn |
| **Background Task Monitoring** | Repetitive busy-polling loops | Enforced Reactive Wakeup with 5-strike circuit breaker |
| **Transcript Review** | Raw JSONL dumped into context | Clean human-readable Markdown via `read_transcript` |
| **Runtime Dependencies** | N/A | **Zero** external npm dependencies (100% Node.js stdlib) + native RTK binary |

---

## MCP Capabilities at a Glance

`Agy-Context-Saver` exposes two distinct interfaces in Antigravity:

* **User Slash Commands (MCP Prompts)**:
  - [`/mcp:agy-context-saver:context_shield`](tools.md#mcp-prompts-mcp-user-slash-commands): One-click prompt template in your chat input that injects the complete 3-layer governance rules and RTK standards into any session.
* **Agent MCP Tools**:
  - [`check_context_health`](tools.md#1-check_context_health): Diagnoses transcript turn counts, payload size, and polling loops.
  - [`subagent_brief`](tools.md#4-subagent_brief): Formulates scope-isolated prompts for delegated subagents.
  - [`read_transcript`](tools.md#2-read_transcript): Streams recent conversation history in clean Markdown format.
  - [`query_transcript`](tools.md#3-query_transcript): Forensic filtering and regex search engine for transcripts.
  - [`get_installation_status`](tools.md#5-get_installation_status): Audits live plugin link, hook, MCP server, schemas, and RTK.
  - [`sync_installation`](tools.md#6-sync_installation): Re-verifies and repairs all 4 integration layers in ~25ms.

See the complete [Tool & Prompt Reference](tools.md) for parameter details and usage examples.
