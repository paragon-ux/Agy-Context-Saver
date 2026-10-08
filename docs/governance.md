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

### 1. The Proportional Backoff Engine
To prevent polling spam without creating deadlock traps, `Agy-Context-Saver` calculates cooldown intervals proportional to diagnostic status inspections:

$$\text{requiredBackoffSeconds} = \min\left(600, \text{round}\left(30 \times 2.5^{\max(0, \text{pollCount} - 1)}\right)\right)$$

| Check # | Required Cooldown | Lifecycle Phase / Purpose | Action if Premature |
| :---: | :---: | :--- | :--- |
| **Check 1** | **0s (Immediate)** | Baseline check upon launch | **ALLOWED** (`pollCount = 1`) |
| **Check 2** | **30s** | Quick check for fast tasks | **DENIED** with countdown |
| **Check 3** | **75s (~1.25m)** | Standard build progress | **DENIED** with countdown |
| **Check 4** | **188s (~3.1m)** | Heavy test suite | **DENIED** with countdown |
| **Check 5** | **469s (~7.8m)** | Deep build / hung process | **DENIED** with countdown |
| **Check 6+** | **600s (10m)** | Prolonged process | Denied; trips circuit breaker |

- **Immediate Operations**: `manage_task(Action='kill')` and `manage_task(Action='send_input')` are **always allowed immediately** (0s cooldown, zero penalties).
- **Watchdog Coordination**: Any `schedule` task watchdog timer must be $\ge$ the current required backoff window.

### 2. Task Output Log Lifecycle Gating
- **While RUNNING**: Inspecting `tasks/<taskId>.log` via native tools or shell commands is strictly **DENIED** under Proportional Backoff to prevent polling loops.
- **When COMPLETED**: Inspecting completed task logs is **ALLOWED** via `rtk read tasks/<taskId>.log` under lifecycle governance. Native `view_file` calls are automatically routed to `rtk read`.
- **Silent Running Tasks**: Tasks with transcript start notices remain `RUNNING` regardless of log quiet duration until an explicit finish notice appears, ensuring hung or slow tasks are not prematurely treated as finished.

### 3. Step Output Spillover Safe Harbor
- Antigravity runtime step output spillovers (`.system_generated/steps/<step>/output.txt`) are safe-harbored via `rtk read <path>`, providing automatic line clamping and token windowing.
- Native `view_file` calls on spillovers automatically route to `rtk read`.

### 4. The Transcript Guard
- **Blocked**: Direct `view_file` or shell access targeting `.system_generated/logs/transcript.jsonl`.
- **Redirected**: Automatically guides the agent to `read_transcript` or `query_transcript`.

### 5. Synchronous Window Expansion
- On native `run_command` invocations, the hook automatically upgrades `WaitMsBeforeAsync` from the default ~5,000ms to **10,000ms** (unless `IsDaemon: true`).

---

## 5-Strike Circuit Breaker

To halt runaway autonomous loops where an agent persistently ignores backoff guidance:
- Each premature polling attempt or watchdog violation records a denial in the session ledger (`agy-session-${safeId}.json`).
- At **5 cumulative denials**, the governor trips a `force_ask` circuit breaker: execution is suspended and control is returned to the user via an interactive prompt.

---

## Safety Guarantees & Operational Invariants

1. **Fail-Closed on Governed Operations (LH-10)**: If an exception occurs while evaluating a governed tool, the governor denies the action (`decision: "deny"`) to prevent security bypasses. Unmonitored non-governed tools fail-open.
2. **Sub-5ms Evaluation**: Written in optimized Node.js, compiling and deciding in under 5 milliseconds.
3. **Foreign Configuration Preservation**: Non-Agy hooks (e.g. `waymark-continuity`) and third-party MCP servers (e.g. `waymark-engine`) are strictly preserved during setup, synchronization, and rollback.
4. **Automatic Backups**: Modifying `hooks.json` or `mcp_config.json` automatically writes timestamped `.bak` backups before applying changes.
