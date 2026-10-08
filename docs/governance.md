# Lifecycle Governance & Hooks

The core of `Agy-Context-Saver` is its proactive **Lifecycle Governor** (`execution-guard`), executed during `PreToolUse` lifecycle events before the agent calls native Antigravity tools.

!!! tip "Instant Activation via Slash Command"
    You can explicitly inject and enforce the complete 3-layer context governance rules in any active conversation by typing `/mcp:agy-context-saver:context_shield` in the Antigravity chat input.

---

## The PreToolUse Interception Architecture

```mermaid
sequenceDiagram
    participant LLM as Agent Model
    participant Hook as execution-guard (Hook)
    participant Host as Antigravity Host
    participant Tool as Native Tool / MCP

    LLM->>Host: Tool Invocation Intent
    Host->>Hook: Stdin: JSON Payload (<5ms)
    alt Denied Polling (status <30s)
        Hook-->>Host: decision: "deny", reason: "Yield turn to Reactive Wakeup"
        Host-->>LLM: Intercepted: Yield and wait for reactive notification
    alt Transcript view_file Read
        Hook-->>Host: decision: "deny", redirect: "Use read_transcript"
        Host-->>LLM: Intercepted: Naive JSON read blocked; use MCP tool
    alt Synchronous run_command
        Hook-->>Host: decision: "allow", upgrade: WaitMsBeforeAsync -> 10000
        Host->>Tool: Execute with 10s synchronous window
    else Valid Tool Call
        Hook-->>Host: decision: "allow"
        Host->>Tool: Execute normally
    end
```

---

## Governed Lifecycle Rules

### 1. The Polling Governor
- **Blocked**: Consecutive `manage_task(Action='status')` polling loops spaced <30 seconds apart.
- **Blocked**: Short artificial timers (`schedule(...)` with `DurationSeconds < 120`).
- **Allowed (Safe Harbors)**:
  - Initial `status` call (gives agents an immediate diagnostic peek).
  - Explicit debugging context (e.g. searching for deadlocks, checking hung processes).
  - Multi-agent coordination (`/teamwork-preview` workflows).
  - Watchdog timers (`DurationSeconds >= 120`).
  - Native termination (`manage_task(Action='kill')`).

### 2. The Transcript Guard
- **Blocked**: Direct `view_file` calls targeting `transcript.jsonl` or `transcript_full.jsonl`.
- **Redirected**: Automatically responds with clear instructions guiding the model to use `read_transcript` or `query_transcript`.
- **Permanent Compaction Immunity**: Because the hook intercepts at the execution boundary, it prevents post-compaction amnesia from re-polluting the active context window.

### 3. Synchronous Window Expansion
- On native `run_command` invocations, the hook automatically upgrades `WaitMsBeforeAsync` from the default ~5,000ms to **10,000ms** (unless `IsDaemon: true`).
- Fast builds, test runs, and git commands complete synchronously in-turn rather than detaching into asynchronous background tasks.

---

## 3-Tier Circuit Breaker

To prevent pathological loops where a model persistently ignores denial guidance:

```text
Denial 1-2: Tier 1 (Guidance)
            "Stop polling; yield execution to Reactive Wakeup."
            
Denial 3-4: Tier 2 (Critical Warning)
            "CRITICAL: Polling is wasting context. You must yield your turn."
            
Denial 5+:  Tier 3 (Circuit Breaker: force_ask)
            Execution is immediately halted and control is returned
            to the human user via an interactive prompt.
```

---

## Safety Guarantees & Non-Destructive Operation

1. **Fail-Open Invariant**: If an unexpected exception occurs inside the hook script, the governor immediately defaults to `decision: "allow"`. The agent is never frozen or crashed by the governor.
2. **Sub-5ms Execution**: Written in native Node.js without imports, compiling and deciding in under 5 milliseconds.
3. **Foreign Configuration Preservation**: Non-Agy hooks (e.g. `waymark-continuity`) and third-party MCP servers (e.g. `waymark-engine`) are strictly preserved during installation, synchronization, and uninstallation.
4. **Automatic `.bak` Backups**: Modifying `hooks.json` or `mcp_config.json` always writes timestamped backups before applying diffs.
