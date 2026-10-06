# Antigravity Execution & Context Governance (Agy-Context-Saver)

## Layer 1: Background Task & Polling Ban (Reactive Wakeup SSOT)
- **Ban on Repetitive Busy-Wait Polling**: Do NOT call `manage_task(Action='status')` or rapid `schedule` timers in a tight loop to wait for a running background command. Repetitive busy-wait polling rapidly degrades session stability by flooding the transcript with repetitive ASCII log snapshots and exhausting the context window.
- **Yield Immediately on Background Detach**: If `run_command` moves a process to the background, the agent should normally stop calling tools, emit a concise status line, and yield the turn. Rely primarily on Antigravity's **Reactive Wakeup** (`<SYSTEM_MESSAGE>` completion notification) to resume execution.
- **Safe Harbor — Stuck Task Debugging & Diagnostics**: If a background task might not exit properly (e.g. deadlock, frozen interactive prompt, or failure to terminate), the agent is **never blocked** from inspecting status for debugging. Initial diagnostic status checks and spaced checks (>=30s cooldown) are permitted to determine whether to send input or kill the task.
- **Safe Harbor — Multi-Agent & Teamwork**: Tasks spawned under `/teamwork-preview` or subagent coordination workflows (`invoke_subagent`, `manage_subagents`) are never blocked from monitoring.
- **Watchdog Timers on `schedule`**: Long watchdog timers (`DurationSeconds >= 120`) designed to wake up and catch deadlocked background tasks that fail to exit are explicitly permitted. Only rapid artificial polling loops (<120s) are denied.
- **3-Tier Circuit Breaker Enforcement**: If an agent model stubbornly attempts repeated denied polling calls in succession without yielding, the governor hook enforces an escalating 3-tier circuit breaker:
  - *Tier 1 (Attempts 1–2)*: Standard denial with guidance to yield for Reactive Wakeup.
  - *Tier 2 (Attempts 3–4)*: Escalated critical warning advising of imminent trajectory corruption.
  - *Tier 3 (Attempt 5+)*: Automatic escalation to `force_ask`, immediately freezing autonomous execution to prompt the user and halt runaway loops.

## Layer 2: Fast Synchronous Execution First
- **Maximum Synchronous Window**: Always set `WaitMsBeforeAsync: 10000` (the maximum allowed) on `run_command`.
- **Targeted Test Execution**: In interactive turns, NEVER run full-suite catalogue sweeps or whole-repo tests. Always run targeted test files with `-q` and fail-fast (e.g. `pytest tests/test_execution_phase.py -q -x`) that complete synchronously within <5–8s. This prevents background tasks from detaching and eliminates context bloat.

## Layer 3: Context Offloading & Minimalist Footprint (Subagent Delegation)
- **Subagent Delegation for Deep Context Gathering**: NEVER run broad multi-file explorations, transcript forensics, multi-repository grep sweeps, or raw log investigations directly in the main conversation thread. Delegate context-gathering tasks to subagents (`invoke_subagent` with `research` or `self`). Subagents execute in isolated contexts and return only synthesized, high-signal findings, keeping the main thread's context lean and pristine.
- **Output Compression**: Keep agent outputs concise, structured, and focused. Avoid dumping full-file contents, large raw logs, or repetitive recaps into the conversation. Use targeted slices (`view_file` with line bounds) and short status lines.
- **Ledger Continuity Across Compaction**: Maintain a canonical decision ledger (e.g. `LEDGER.md`). Whenever a milestone is settled, record it in the ledger so that continuity survives context compaction automatically without needing transcript bloat.
