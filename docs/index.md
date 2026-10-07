# Overview & Motivation

**Agy-Context-Saver** is an open-source Model Context Protocol (MCP) server and lifecycle governor engineered specifically for **Google Antigravity** (`agy`).

It eliminates session degradation, memory leaks, and context window exhaustion caused by two independent failure modes in autonomous coding agents: **background task busy-wait polling** and **raw transcript reading**.

---

## Why Agy-Context-Saver?

Because third-party extension distribution to the official Google Antigravity marketplace is currently restricted, `Agy-Context-Saver` leverages the **open Model Context Protocol (MCP)** specification alongside native Antigravity lifecycle hooks. 

Any developer running Antigravity on macOS, Linux, or Windows can install and activate the governor immediately without external cloud dependencies or binary compilers.

---

## The Two Context Traps

Without proactive lifecycle governance, autonomous agent sessions frequently encounter severe conversational context corruption:

```mermaid
graph TD
    subgraph Trap1["Trap 1: The Busy-Waiting Loop"]
        A1["Long-running Command (>5s)"] --> B1["Detached to Background Task"]
        B1 --> C1["Agent polls manage_task('status')"]
        C1 --> D1["Hundreds of raw progress lines dumped"]
        D1 --> E1["Context inflated by 50-100 KB/min"]
        E1 --> C1
    end

    subgraph Trap2["Trap 2: The Raw JSON Transcript Trap"]
        A2["Agent seeks forensic history"] --> B2["Calls view_file('transcript.jsonl')"]
        B2 --> C2["Multi-megabyte raw JSON dumped"]
        C2 --> D2["Context Compaction triggered"]
        D2 --> E2["Post-compaction amnesia reverts agent to habit"]
        E2 --> B2
    end
```

### 1. The Background Task Polling Trap
When an agent initiates a shell command exceeding `WaitMsBeforeAsync` (~5 seconds), Antigravity detaches the process into a background task (`task-XYZ`).
- **The Anti-Pattern**: Large Language Models exhibit an innate busy-waiting bias: they repeatedly invoke `manage_task(Action='status')` or schedule short 5–10s timers (`schedule(...)`) rather than yielding execution to the native **Reactive Wakeup** system.
- **The Log Explosion**: Each status check appends the entire accumulated process stdout buffer (ANSI escape codes, compiler progress dots, raw build logs) into the conversation history.
- **The Consequence**: Transcripts bloat rapidly, pushing critical user instructions and architectural constraints out of the attention window, degrading model reasoning and causing session stalls.

### 2. The Raw Transcript Reading Trap
When reviewing prior turns, inspecting subagent findings, or diagnosing errors, system instructions prompt agents to inspect transcripts at `.system_generated/logs/transcript.jsonl`.
- **The Raw JSON Tax**: Agents execute native `view_file` on multi-megabyte JSONL files, filling working memory with escaped quotes, bracket noise, timestamps, and massive tool payload blobs.
- **The Two-File Sync Tax**: Because large tool outputs in `transcript.jsonl` are truncated, agents must manually look up matching line numbers in `transcript_full.jsonl`, wasting cognitive budget on mechanical parsing.
- **Post-Compaction Amnesia**: When context compaction triggers, the agent's short-term conversational context is compressed, and the model reverts to its baseline system prompt habits. It immediately attempts another `view_file` read on `transcript.jsonl`, re-polluting the newly compacted window with thousands of tokens of raw JSON overhead.

---

## Core Value Proposition

| Metric / Feature | Without Governor | With Agy-Context-Saver |
| :--- | :--- | :--- |
| **Long Command Execution** | Detached after 5s $\to$ busy-wait loop | Synchronous window expanded to 10s $\to$ finishes cleanly in-turn |
| **Output Log Bloat** | Unlimited raw dots, ANSI dumps | Adaptive semantic reduction (2–4 KB target) + 24 KB ceiling |
| **Transcript Review** | Raw JSONL dumped into context | Clean human-readable Markdown via `read_transcript` |
| **Forensic Search** | Full file scans across 2 files | Filtered, auto-dereferenced queries via `query_transcript` |
| **UI Step Height & Readability** | Multi-screen scrolling run-on cards | `verbosity: "quiet"` 1-line badges & Markdown ` ```text ` code fences |
| **Runtime Dependencies** | N/A | **Zero** external npm dependencies (100% Node.js stdlib) |
