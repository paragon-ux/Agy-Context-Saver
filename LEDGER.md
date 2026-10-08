# Agy-Context-Saver Governance & Loophole Ledger (LEDGER.md)

**Audit Target**: `Agy-Context-Saver` Lifecycle Governor & Execution Framework  
**Incident Reference**: Incident `609d4489-2e7f-44b0-8170-390ee67cad97` (*"MCP Command Testing and Output"*)  
**Scope**: PreToolUse Hook (`scripts/execution-guard-hook.mjs`), Universal MCP Server (`mcp/index.js`), and Agent Rules (`rules/AGENTS.md`)  
**Last Updated**: October 7, 2026 (v1.2.1 / v1.3.0 Governance Hardening)  

---

## 1. Executive Summary

During initial testing of autonomous execution governors, agents routinely fell into **the Polling Trap** (repeated `manage_task(status)` calls) and **the Terminal Bloat Trap** (uncompressed stdout/stderr), inflating conversation transcripts to over 3.3 MB (911 tool calls).

To counter this, early versions of `Agy-Context-Saver` implemented strict heuristic bans. However, a comprehensive forensic review identified 10 fundamental architectural loopholes (**LH-01** through **LH-10**), as well as an unintended **"Pendulum Freeze"** side-effect where an absolute ban on polling left long-running background tasks with zero recovery mechanism when they stalled or deadlocked.

This document serves as the permanent Single Source of Truth (SSOT) tracking every identified loophole, remnant escape vector, and the mathematical **Proportional Backoff & Closed Execution Architecture** implemented to eliminate them.

---

## 2. Master Loophole Matrix (LH-01 to LH-10)

| ID | Category | Original Vulnerability & Exploit Pattern | Resolution & Enforcement Mechanism | Status |
| :--- | :--- | :--- | :--- | :---: |
| **LH-01** | Command Substitution | Agent abandoned `safe_command` and ran 354 native `run_command` calls (~450 KB uncompressed logs). | **Closed by Design**: Retired `safe_command`. Native `run_command` calls are transparently rewritten via `rtk rewrite` at the PreToolUse hook boundary. | **RESOLVED** |
| **LH-02** | Task Log Route-Around | Hook only regex-checked `transcript.jsonl`. Model read `.system_generated/tasks/task-1521.log` 19× via `view_file` to bypass status checks. | **Closed at Root**: Root guard blocks any path containing `.system_generated` across all file inspection tools (`view_file`, `read_file`, `grep_search`, etc.). | **RESOLVED** |
| **LH-03** | Long Watchdog Exemption | Hook had a blind exemption: `if (duration >= 120) allow`, letting agents chain 180s timers turn-by-turn to wait in the foreground. | **Closed**: Blind duration exemptions removed. All task polling timers are coordinated with the Proportional Backoff Engine. | **RESOLVED** |
| **LH-04** | Keyword Safe Harbor | Matching "debug", "stuck", "diagnos", "timeout" granted blanket bypass to all rate limiters. | **Closed**: Keyword search completely excised. No prompt or argument keywords grant governance immunity. | **RESOLVED** |
| **LH-05** | Interleaving Cooldown Reset | Permitted calls if $>2$ steps elapsed or $>30$s elapsed, resetting `denials = 0` whenever the agent read an intermediate file. | **Closed**: Step-interleaving reset eliminated. Denials and backoff levels increment monotonically within the session. | **RESOLVED** |
| **LH-06** | Per-Key Ledger Partitioning | State was partitioned by `${convId}:${taskId}`. Switching task IDs started a clean ledger with 0 denials. | **Closed**: Session ledger tracks task lifecycles globally per conversation ID in `agy-session-${safeId}.json`. All task IDs are unified. | **RESOLVED** |
| **LH-07** | Read Redundancy | Unbounded full-file `view_file` calls (369 reads, 1.05 MB; `session_engine.py` read 36×). | **Closed**: Workspace inspection tools are denied and hard-routed to `rtk read`, `rtk find`, and `rtk rg`. Special files (`SKILL.md`, brain artifacts) preserved. | **RESOLVED** |
| **LH-08** | Delegation Void | Agent never spawned subagents; ran all 57-prompt sweeps in main thread. Prose in `AGENTS.md` was ignored. | **Mitigated**: Provided `subagent_brief` tool for scope-isolated prompt formulation; session warning thresholds added for high main-thread tool counts. | **ACTIVE MITIGATION** |
| **LH-09** | Semantic Blindness | Model edited benchmarks/evaluators (`eval_accuracy.py`, prompt templates) to overfit test scores. | **Closed**: `replace_file_content` and `write_to_file` gate any path matching benchmark/evaluator patterns behind `force_ask`. | **RESOLVED** |
| **LH-10** | Error Fallback | Catch blocks called `failOpen()`, letting unparsed payloads pass without inspection. | **Closed**: Governed tools fail-closed (`decision: "deny"`) on any exception or schema error. | **RESOLVED** |
| **LH-11** | Silent Sweep Exhaustion | Agent ran bare multi-file test sweeps (`pytest`, 928 tests, ~8m). Because RTK aggregates output until exit, `task.log` had 0 bytes, blinding user. Agent yielded silently without watchdog. | **Closed**: Fail-fast (`-x`) made opt-in to avoid whack-a-mole loops and preserve test blast radius; Coordinated Watchdog Protocol (`schedule` $\ge 30\text{s}$) and Pre-Yield Status Cards codified in `AGENTS.md`. | **RESOLVED** |
| **LH-12** | Output Blind-Spot Catch-22 | Ephemeral spillover files ($>24\text{ KB}$) and post-mortem task logs blocked by root guard; subagent messages severed by arbitrary 80-char argument slicing. | **Closed (v1.4.0)**: Dedicated `get_spillover_content` MCP bridge, lifecycle-gated `read_task_output`, typed descriptors in `formatTranscriptItem`, `get_step_detail` surgical dereferencer, and Pointer-Over-Wire (POW) contract. | **RESOLVED** |

---

## 3. Remnant Loophole Findings (Audit v1.2.1)

A secondary forensic audit of the v1.2.1 codebase uncovered 3 critical remnant bypass routes and the "Pendulum Freeze" failure mode:

### Remnant A (LH-02-B): Shell Command Access to `.system_generated`
* **Vulnerability**: While `isProtectedInternalState()` was enforced on `view_file` and `read_file`, it was **omitted** inside the `run_command` handler.
* **Exploit Vector**: If `view_file` on `.system_generated/tasks/task-1521.log` was denied, an agent could bypass the guard by running:
  ```powershell
  Get-Content "C:\...\.system_generated\tasks\task-1521.log"
  # or
  rtk read "C:/.../.system_generated/logs/transcript.jsonl"
  # or
  cat "C:/.../.system_generated/tasks/task-1521.log"
  ```
* **Remediation**: Added `isProtectedInternalState(rawCmd)` directly inside the `run_command` pre-tool hook, blocking any shell command referencing `.system_generated`.

### Remnant B (LH-01-B): Shell Wrapper Bypass (`cmd /c` & `powershell -c`)
* **Vulnerability**: `NON_REWRITABLE_BINARIES` included `"cmd"`, `"powershell"`, and `"pwsh"`. The hook checked only `firstWord`.
* **Exploit Vector**: If an agent wrapped commands in a subshell:
  ```bash
  cmd /c "git status"
  # or
  powershell -Command "pytest -v test_suite.py"
  ```
  The hook matched `firstWord === "cmd"`, bypassed `rtk rewrite`, and executed raw uncompressed output.
* **Remediation**: Added shell wrapper unwrapping (`cmd /c`, `powershell -Command`, `powershell -c`, `pwsh -c`, `bash -c`) before evaluating `firstWord` and rewriting.

### Remnant D (LH-11): Silent Background Execution & Bare Sweep Exhaustion (Incident `07b0f8d8`)
* **Incident Reference**: Incident `07b0f8d8-0a2c-47ca-9330-e4ed04471a51` (*"Revert Diff And Fix Benchmarks"*).
* **Vulnerability & Exploit Pattern**: 
  1. The agent called bare `pytest` in an interactive session turn inside a large codebase (`PDLt-Test`, 48 test files, 928 tests, 6–8 minutes total runtime).
  2. Because RTK aggregates and parses test output to output a compact summary upon process exit, RTK buffers child stdout/stderr in memory.
  3. Consequently, `task-30.log` remained at exactly **0 bytes** during the entire execution window.
  4. The agent yielded its turn with a generic status notice and set no watchdog timer.
  5. In Antigravity's UI, a background task with 0 bytes of log output and `Last progress: never` for 80+ seconds is visually indistinguishable from an engine freeze or deadlock.
* **Remediation & Architectural Separation**:
  1. **Native Command Semantics (Opt-In Fail-Fast)**: Fail-fast flags (`-x`, `--maxfail=1`) remain strictly **opt-in** rather than forced at the hook boundary. This avoids the "whack-a-mole" trap where stopping at the first failure conceals the full blast radius across multiple modules and causes repetitive round trips.
  2. **Coordinated Watchdog Protocol**: Mandated in `rules/AGENTS.md` that any background operation expected to exceed 15s must be paired with `schedule(DurationSeconds=45, TimerCondition="task-...")`. If the operation is prolonged, the watchdog wakes the agent to perform a legal status check and post a live chat progress update for the user.
  3. **Mandatory Pre-Yield Status Cards**: Mandated in `rules/AGENTS.md` that agents must output a structured markdown card (command, scope, estimated duration, watchdog tier) before yielding on background tasks.
  4. **Subagent Delegation for Deep Sweeps**: Instructed in `rules/AGENTS.md` that comprehensive repository-wide test sweeps must be delegated to subagents (`invoke_subagent`) to keep the primary interactive session responsive.

---

### Remnant C (LH-03-B / The Pendulum Freeze Trap): Indefinite Hung Tasks
* **Vulnerability**: In closing LH-03 and LH-05, all `schedule` task timers and all subsequent `manage_task(status)` calls were **permanently denied**.
* **Exploit Vector / Failure Mode**: If a command hangs on interactive `stdin` (`[y/N]`), enters an infinite loop, or deadlocks:
  1. The process never exits, so native **Reactive Wakeup never fires**.
  2. The agent is denied from scheduling a watchdog timer.
  3. The agent is denied from checking `manage_task(status)`.
  4. The agent yields its turn into a black hole; the background process runs forever, consuming CPU and wedging the session permanently.
* **Remediation**: Replaced the binary lifetime ban with the **Proportional Backoff Protocol**.

### Remnant E (LH-12): Output Blind-Spot & Spillover Catch-22 (Audit v1.4.0)
* **Incident Reference**: Research audit in conversation `07b0f8d8-0a2c-47ca-9330-e4ed04471a51` / [`LEDGER_OUTPUT_FIXES.md`](file:///c:/Users/USER/Desktop/Frameworks/Agy-Context-Saver/LEDGER_OUTPUT_FIXES.md).
* **Vulnerability & Failure Mode**:
  1. **Runtime Output Spillovers**: When MCP or tool responses exceed Antigravity's inline threshold ($>24\text{ KB}$), the engine redirects output to `.system_generated/steps/<step>/output.txt`. The PreToolUse hook unconditionally blocked all access to `.system_generated`, creating an unbreakable Catch-22 where the agent was told to inspect a file it was forbidden from reading.
  2. **Post-Mortem Task Logs**: Completed background task outputs that exceeded inline truncation thresholds left stack traces in `tasks/task-*.log`. The hook's binary root ban prevented reading logs even after the task finished, blinding agents to build and test failure details.
  3. **Transcript Argument Mutilation**: `formatTranscriptItem()` hardcoded `.slice(0, 80)` on all tool call arguments, destructively severing JSON structures and subagent reports passed in `send_message(Message="...")`.
  4. **In-Band Message Truncation**: Subagents transmitting large deliverables over `send_message` hit the platform's ~16–20 KB message boundary, truncating findings before reaching parent context.
* **Remediation & Four Architectural Pillars (Streamlined 0-New-Tools Model)**:
  1. **Safe-Harbor `rtk read` for Step Spillovers (0 New Tools)**: Eliminated tool proliferation by avoiding bespoke tools. `rtk read` already has native line windowing and filtering. The hook creates a safe harbor allowing `rtk read` on `/\.system_generated\/steps\/\d+\/output\.txt$/`, hard-routing native `view_file` calls directly to `rtk read <path>`.
  2. **Lifecycle-Gated Task Output Inspection via `rtk read` (0 New Tools)**: When an agent attempts `rtk read tasks/<taskId>.log`, the hook strictly **denies** with Proportional Backoff countdown while the task is `RUNNING` to stop polling loops. Once `COMPLETED` / `TERMINATED`, `rtk read` is allowed under lifecycle governance for bounded error and stack trace retrieval.
  3. **Folded Surgical Step Dereferencing into `query_transcript` (0 New Tools)**: Rather than adding a bespoke dereferencing tool, added optional `stepIndex` (number) and `field` (string) parameters directly to the existing `query_transcript` tool. `query_transcript(stepIndex=974)` surgical extracts the un-truncated full payload from `transcript_full.jsonl`. Replaced blind 80-char slicing in `formatTranscriptItem()` with typed argument descriptors (`[14.2 KB String]`, `[Array(5)]`).
  4. **Pointer-Over-Wire (POW) Subagent Contract**: Updated `subagent_brief` to automatically inject the POW delivery contract: deliverables $>1\text{ KB}$ are written to workspace files (`scratch/...`), while `send_message` transmits only high-signal summaries and clickable file links. The canonical tool registry is preserved at exactly 6 core tools with zero agent cognitive load and zero schema token tax.

---

## 4. The Proportional Backoff Protocol Specification

To prevent high-frequency busy-waiting spam **without creating an unmonitored deadlock trap**, `Agy-Context-Saver` implements a deterministic exponential backoff curve for task diagnostic inspections:

### Backoff Curve & Levels

```text
Formula:
requiredBackoffSeconds = Math.min(600, Math.round(30 * Math.pow(2.5, Math.max(0, pollCount - 1))))
```

| Check Level | Required Cooldown Since Last Inspection | Lifecycle Phase / Purpose | Premature Call Action ($< \text{Backoff}$) |
| :---: | :---: | :--- | :--- |
| **Check #1** | **$0\text{s}$ (Immediate)** | Baseline inspection upon command launch | **ALLOWED** (`pollCount = 1`, `lastPollTime = now`) |
| **Check #2** | **$30\text{s}$** | Quick check for fast tasks or short tests | **DENIED** with countdown; increments denials |
| **Check #3** | **$75\text{s}$ (~1.25 min)** | Standard build / compilation progression | **DENIED** with countdown; increments denials |
| **Check #4** | **$188\text{s}$ (~3.1 min)** | Heavy test suite or remote operation | **DENIED** with countdown; increments denials |
| **Check #5** | **$469\text{s}$ (~7.8 min)** | Deep build / suspected hung process | **DENIED** with countdown; increments denials |
| **Check #6+** | **$600\text{s}$ (10 min ceiling)** | Prolonged process; requires manual review | Triggers `force_ask` circuit breaker |

### Operational Rules

1. **Premature Calls are Denied**: If `manage_task(status)` is called before `requiredBackoffSeconds` has elapsed, the hook returns `decision: "deny"` with the exact seconds remaining.
2. **5-Strike Circuit Breaker**: If an agent makes 5 consecutive premature calls within active backoff windows, the autonomous loop is suspended via `force_ask`.
3. **Hung Task Recovery**: If a task has been running silently for $\ge$ the required backoff window, the inspection is **ALLOWED**. The agent receives the live status and log output, enabling it to detect deadlocks and issue `manage_task(Action='kill')`.
4. **Immediate Kill Exemption**: `manage_task(Action='kill')` and `manage_task(Action='send_input')` are **always permitted immediately** ($0\text{s}$ backoff, zero penalties).
5. **Watchdog Timer Coordination**: For `schedule`, any watchdog timer monitoring a task must have `DurationSeconds >= requiredBackoffSeconds`. It auto-cancels if the task finishes early, and only wakes the agent if the task runs for the full backoff window.

---

## 5. Architectural Invariants

1. **Closed Execution**: No shell command or inspection tool may bypass RTK output optimization on workspace code or native tools.
2. **Root Isolation**: Antigravity internal execution state (`.system_generated/`) cannot be inspected via native file tools OR shell commands.
3. **Reactive Wakeup Priority**: Normal task completion notifies the agent automatically via `<SYSTEM_MESSAGE>`. Polling is strictly a secondary diagnostic fallback governed by proportional backoff.
4. **Fail-Closed on Governed Operations**: Any runtime error in evaluating a governed tool call denies execution to preserve session integrity.
