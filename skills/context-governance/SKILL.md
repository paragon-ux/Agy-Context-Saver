---
name: context-governance
description: >-
  Use when running shell commands with large outputs, inspecting session transcript health,
  preventing repetitive background polling loops, or delegating heavy research to subagents.
---

# Context Governance & Execution Guard (Agy-Context-Saver)

Agy-Context-Saver protects session transcript health and LLM attention by preventing repetitive busy-wait polling, compressing noisy test dot outputs, and offloading deep research to sandboxed subagents.

## Available MCP Tools

### 1. `safe_command`
Executes shell commands with generous timeouts and intelligent log compression. Collapses massive streams of test dots, repeated log rows, and pathological output to prevent transcript pollution.
- **Parameters**:
  - `command` (string, required): Shell command to execute.
  - `cwd` (string, optional): Working directory.
  - `timeoutSeconds` (number, default: 30): Generous execution ceiling with escalating SIGKILL protection.
  - `maxOutputLines` (number, default: 30): Output lines preserved before collapsing repetitive middle sections.

### 2. `check_context_health`
Performs asynchronous streaming inspection of `transcript.jsonl` to calculate turn budgets, step counts, raw payload size, and detect busy-polling loops.
- **Parameters**:
  - `transcriptPath` (string, required): Absolute path to `transcript.jsonl`.

### 3. `subagent_brief`
Generates a strictly formatted, scope-isolated prompt for delegating research or debugging to a subagent (`invoke_subagent`).
- **Parameters**:
  - `objective` (string, required): Core investigative or implementation goal.
  - `scopeFiles` (array of strings, optional): Specific file targets.
  - `expectedDeliverable` (string, optional): Expected concise synthesis format.

### 4. `get_installation_status`
Audits the 4 Antigravity integration layers (Native Plugin Link, Lifecycle Hook in `hooks.json`, MCP Server in `mcp_config.json`, and Tool Schemas in Antigravity directory).

### 5. `sync_installation`
Re-verifies, repairs, and synchronizes the global Antigravity installation in ~25ms without terminal shell commands.
- **Parameters**:
  - `checkOnly` (boolean, default: false): Dry-run audit mode.

## 3-Layer Governance Rules

1. **Layer 1: Reactive Wakeup First**:
   - Never busy-wait on `manage_task(Action='status')` or rapid `<120s` timers.
   - Stop calling tools and yield the turn for native Reactive Wakeup (`<SYSTEM_MESSAGE>`).
   - For debugging stuck/hung tasks, initial status inspections and spaced cooldown checks (>=30s) are permitted under Safe Harbor.
   - Repeated denied polling triggers an automatic 3-tier circuit breaker: Tier 1 (guidance) $\to$ Tier 2 (critical warning) $\to$ Tier 3 (`force_ask` autonomous freeze).

2. **Layer 2: Fast Synchronous Execution**:
   - Commands default to `WaitMsBeforeAsync: 10000` to complete synchronously without background detachment.

3. **Layer 3: Subagent Delegation**:
   - Broad grep sweeps and multi-file exploration are delegated to subagents to preserve main thread context.
