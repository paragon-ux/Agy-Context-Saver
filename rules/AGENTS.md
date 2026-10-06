# Antigravity Execution & Context Governance (Agy-Context-Saver)

## Layer 1: Background Task & Polling Ban (Reactive Wakeup SSOT)
- **Hard Ban on Polling / Busy-Waiting**: NEVER call `manage_task(Action='status')` or `schedule` in a loop to wait for a running background command. Polling rapidly degrades session stability by flooding the transcript with repetitive ASCII log snapshots, exhausting the context window, and causing session stalls.
- **Yield Immediately on Background Detach**: If `run_command` moves a process to the background, the agent MUST immediately stop calling tools. Emit a single concise progress sentence and end the turn. Rely strictly on Antigravity's **Reactive Wakeup** (`<SYSTEM_MESSAGE>` completion notification) to resume execution.
- **`schedule` Governance**: NEVER use `schedule` as an artificial `sleep` or polling timer for background tasks. `schedule` is reserved exclusively for user-requested future reminders or standing cron jobs.

## Layer 2: Fast Synchronous Execution First
- **Maximum Synchronous Window**: Always set `WaitMsBeforeAsync: 10000` (the maximum allowed) on `run_command`.
- **Targeted Test Execution**: In interactive turns, NEVER run full-suite catalogue sweeps or whole-repo tests. Always run targeted test files with `-q` and fail-fast (e.g. `pytest tests/test_execution_phase.py -q -x`) that complete synchronously within <5–8s. This prevents background tasks from detaching and eliminates context bloat.

## Layer 3: Context Offloading & Minimalist Footprint (Subagent Delegation)
- **Subagent Delegation for Deep Context Gathering**: NEVER run broad multi-file explorations, transcript forensics, multi-repository grep sweeps, or raw log investigations directly in the main conversation thread. Delegate context-gathering tasks to subagents (`invoke_subagent` with `research` or `self`). Subagents execute in isolated contexts and return only synthesized, high-signal findings, keeping the main thread's context lean and pristine.
- **Output Compression**: Keep agent outputs concise, structured, and focused. Avoid dumping full-file contents, large raw logs, or repetitive recaps into the conversation. Use targeted slices (`view_file` with line bounds) and short status lines.
- **Ledger Continuity Across Compaction**: Maintain a canonical decision ledger (e.g. `LEDGER.md`). Whenever a milestone is settled, record it in the ledger so that continuity survives context compaction automatically without needing transcript bloat.
