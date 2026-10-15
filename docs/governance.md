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
    participant RTK as RTK Optimizer
    participant Tool as Native Tool / MCP

    LLM->>Host: Tool Invocation Intent
    Host->>Hook: Stdin: JSON Payload (<5ms)
    alt Layer 1: Denied Polling (status within cooldown)
        Hook-->>Host: decision: "deny", reason: "Yield turn to Reactive Wakeup"
        Host-->>LLM: Intercepted: Yield and wait for reactive notification
    alt Layer 2: Shell Command Rewriting
        Hook-->>Host: decision: "allow", rewrite: "git status" -> "rtk git status"
        Host->>RTK: Execute compressed via RTK (10s synchronous window)
    alt Layer 2: Workspace Codebase Inspection
        Hook-->>Host: decision: "deny", redirect: "Use rtk read / rtk find / rtk rg"
        Host-->>LLM: Intercepted: Full-file inspection routed to RTK CLI
    alt Layer 2: Transcript File Access (.system_generated)
        Hook-->>Host: decision: "deny", redirect: "Use read_transcript / query_transcript"
        Host-->>LLM: Intercepted: Internal state protected; use MCP tools
    alt Layer 3: Synchronous run_command Window
        Hook-->>Host: decision: "allow", upgrade: WaitMsBeforeAsync -> 10000
        Host->>Tool: Execute with expanded 10s sync window
    else Valid Tool Call
        Hook-->>Host: decision: "allow"
        Host->>Tool: Execute normally
    end
```

---

## Canonical 3-Layer Governance Invariants

### Layer 1: Reactive Lifecycle & Polling Immunity

#### 1. The Proportional Backoff Engine
Instead of busy-waiting on background tasks, agents must yield control to **Reactive Wakeup** (`<SYSTEM_MESSAGE>`). When diagnostic status checks are legally required, intervals scale along an exponential curve:

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
- **Watchdog Coordination**: Any `schedule` task watchdog timer must be $\ge \max(30, \text{requiredBackoffSeconds})$ and pair with a structured Pre-Yield Status Card.
- **5-Strike Circuit Breaker**: At **5 cumulative denials**, the governor trips a `force_ask` circuit breaker: execution is suspended and control is returned to the user via an interactive prompt.
- **Task Output Log Lifecycle Gating**:
  - *While RUNNING*: Inspecting `tasks/<taskId>.log` via native tools or shell commands is strictly **DENIED** under Proportional Backoff.
  - *When COMPLETED*: Inspecting completed task logs is **ALLOWED** via `rtk read tasks/<taskId>.log` under lifecycle governance.

---

### Layer 2: Transparent CLI & Codebase Streamlining

#### 1. Transparent Shell Command Rewriting
Shell commands executed via `run_command` (`git`, `pytest`, `cargo`, `npm`, etc.) are transparently rewritten to their RTK equivalents (`rtk git`, `rtk pytest`), reducing stdout/stderr token consumption by up to 80% without requiring agent behavior changes.

#### 2. Canonical Codebase Inspection Routing
Native tools that bypass RTK token filtering on workspace source files (`view_file`, `grep_search`, `find_by_name`, `list_dir`) are intercepted and hard-routed to RTK canonical CLI commands (`rtk read`, `rtk find`, `rtk rg "<pattern>" .`). Bounded source inspections ($\le 150$ lines) and Antigravity special files (`SKILL.md`, brain artifacts) are permitted via safe harbor.

#### 3. Step Output Spillover Safe Harbor
Antigravity runtime step output spillovers (`.system_generated/steps/<step>/output.txt`) are safe-harbored via `rtk read <path>`, providing automatic line clamping and token windowing.

#### 4. The Transcript Guard
Direct native inspection of `.system_generated/logs/transcript.jsonl` is blocked. Agents are routed to `read_transcript` and `query_transcript`.

---

### Layer 3: Synchronous Execution

#### 1. Synchronous Window Expansion
On native `run_command` invocations, the hook automatically upgrades `WaitMsBeforeAsync` from the default ~5,000ms to **10,000ms** (unless `IsDaemon: true`), allowing tasks to complete synchronously and preventing premature detachment.

#### 2. Benchmark & Evaluator Safeguard
Mutations to benchmark definitions, test evaluation templates, or scoring artifacts are protected behind mandatory `force_ask` user approval.

---

## Enterprise Non-Destructive Safety Guarantees

1. **Foreign Configuration Preservation**: Non-Agy hooks (e.g. `waymark-continuity`) in `hooks.json` and third-party MCP servers (e.g. `waymark-engine`) in `mcp_config.json` are strictly preserved during setup, synchronization, and rollback.
2. **Atomic Backups**: Modifying `hooks.json` or `mcp_config.json` automatically writes timestamped `.bak` backups before applying any change.
3. **Zero Runtime Dependencies**: Written in 100% native Node.js standard library with 0 external npm dependencies and sub-5ms hook execution.
4. **Fail-Closed on Governed Operations (LH-10)**: If an unhandled error occurs while evaluating a governed tool, the governor fails closed (`decision: "deny"`) to guarantee security. Non-governed tools fail open.
