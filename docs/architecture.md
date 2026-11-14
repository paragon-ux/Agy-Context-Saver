# Architecture & Internals

`Agy-Context-Saver` implements a **Closed Execution Topology** for Google Antigravity, offloading shell command optimization entirely to **RTK (Rust Token Killer)** while hardening lifecycle governance and session integrity.

---

## Closed Execution Topology

```text
                         Antigravity Agent
                                |
             +------------------+------------------+
             |                                     |
        run_command                         native inspection /
             |                              lifecycle tools
             v                                     |
        RTK hook                                    |
             |                             +---------+----------+
             v                             |                    |
        RTK execution                  inspection tools      lifecycle
             |                             |                    |
             v                             v                    v
     compact command output          Agy DENY + route      Agy governance
                                           |                    |
                                           v                    v
                                      RTK read/grep/find     Agy MCP
                                           |                    |
                                           +---------+----------+
                                                     |
                                                     v
                                              useful context
```

---

## Division of Responsibilities

### RTK (Rust Token Killer) Owns:
- Shell command interception and transparent rewriting (`rtk rewrite`)
- Language- and tool-specific command output reduction (`git`, `pytest`, `cargo`, `npm`, `tsc`, `docker`, etc.)
- Canonical codebase inspection CLI (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`, `rtk tree`)
- Diagnostic reduction (`rtk err`, `rtk summary`)

### Agy-Context-Saver Owns:
- Antigravity lifecycle management & Reactive Wakeup enforcement
- Background task polling governance & 5-strike circuit breaker
- Antigravity internal state protection (`.system_generated/`)
- Zero-JSON Markdown transcript extraction (`agy-context transcript read|query|step|health`)
- Benchmark and evaluation artifact mutation protection (`edit_file`, `write_file`, and shell guards)

---

## Key Technical Subsystems

### 1. Transparent RTK `>= 1.1.0` Hook Delegation
Antigravity's `PreToolUse` hook intercepts `run_command`. After running safety and policy guards, Agy delegates command optimization to `rtk hook antigravity` via stdin JSON:
- If the command is optimizable (`git status`, `pytest`, `cargo test`), RTK returns an updated `CommandLine` rewrite (`rtk git`, `rtk pytest`, `bash -c 'rtk ...'`).
- Agy reverts lossy implicit `wc`/`ls`/`diff` rewrites (unless explicitly invoked as `rtk ...`), guards absent host `rg` (`rtk grep` or unprefixed fallback), and sets `WaitMsBeforeAsync: 10000` only when unset and non-daemon.
- If unsupported or `rtk >= 1.1.0` is absent, the command passes through unchanged (graceful fallback).

### 2. Unified 3-Tier Inspection & Hard Routing of Unbounded Tools
Unbounded native Antigravity file and search tools (`read_file` without slices, `view_file`, `grep_search`, `find_by_name`, `list_dir`) bypass token reduction:
- Workspace file inspection follows `rtk grep` / `rtk find` / `rtk ls` $\to$ bounded `read_file(StartLine, EndLine)` slices ($\le 150$ lines, or explicit `1..TotalLines` for files $\le 800\text{L} / 45\text{ KiB}$) to preserve 1-indexed line coordinates for `edit_file` and `write_file`.
- Documented Antigravity special files (`SKILL.md`, `AGENTS.md`, brain artifacts, `.gemini/config/`) remain accessible without slice bounds through Safe Harbor.

### 3. Root-Based Internal State Protection
Segment-, quote-, and heredoc-aware parsing guards `.system_generated/` commands while avoiding false denials on heredoc bodies or search patterns:
- Direct shell access to `.system_generated/logs/transcript*` or running `tasks/*.log` is denied immediately and routed to `agy-context transcript ...`.
- Only strictly unchained `rtk read <spillover/completed-task-log>` and strictly unchained `agy-context transcript ...` commands are exempted.

### 4. Closed Session-Wide Lifecycle Ledger
Historical loopholes exploited per-task cooldown resets and fuzzy keywords. Agy implements a session-level lifecycle ledger:
- Polling history does NOT reset when changing task IDs, waiting 30 seconds, or interleaving steps.
- Keywords such as "debug", "stuck", or "timeout" do not grant exemptions.
- Long timers (`DurationSeconds >= 120`) do not grant exemptions.
- 5 cumulative denials trigger `force_ask` to halt runaway autonomous loops.

### 5. Benchmark & Evaluator Mutation Protection
During active evaluation sessions, mutating benchmark definitions, prompt templates, or scoring files (via `edit_file`, `write_file`, `replace_file_content`, `write_to_file`, or shell redirects/deletes) requires explicit user confirmation via `force_ask`, preventing prompt contamination and benchmark overfitting.

---

## 6. Output Governance & Spillover Safe Harbor

1. **Bounded Step Output Spillovers**:
   When Antigravity spills large tool outputs to disk (`.system_generated/steps/<step>/output.txt`), the PreToolUse hook allows bounded `read_file(StartLine, EndLine <= 150)` and single unchained `rtk read <path>` calls.
2. **Lifecycle-Gated Task Output Inspection**:
   When an agent inspects background task logs (`tasks/<taskId>.log`):
   - While `RUNNING`: Strictly denied under Proportional Backoff to eliminate busy-waiting polling loops.
   - When `COMPLETED` / `TERMINATED`: Allowed via single unchained `rtk read tasks/<taskId>.log`.
3. **Surgical Step Dereferencing via CLI (`agy-context transcript step`)**:
   Single-step extraction uses `agy-context transcript step --id <conv> --step <N> [--field ...]` to recover untruncated payloads from `transcript_full.jsonl` with zero surrounding context bloat.

---

## 7. Performance & Resource Optimization Invariants

1. **Guaranteed Stream Destruction (PERF-01, PERF-02)**:
   All readline and transcript stream readers wrap iteration in `try / finally` with explicit `fileStream.destroy()`. Probe tests verify zero open file descriptor leakage across early exits and line caps.
2. **Subprocess Spawn Elimination (PERF-03)**:
   The PreToolUse hook drops redundant version probes, spawning `rtk rewrite` directly and falling back to plugin binaries only on `ENOENT`, cutting cache miss latency by over 50ms.
3. **Surgical 256KB Tail-Window Task State Resolution (PERF-04, PERF-07)**:
   Task lifecycle checking uses a single unified resolver scanning the last 256KB of `transcript.jsonl` with literal needle matching, reducing inspection time on 10MB transcripts from 123ms to 2ms (-98%).
4. **Safe Bounded Subprocess Delegation**:
   Shell command rewriting delegates directly via stdin JSON to `rtk hook antigravity` (`>= 1.1.0`), avoiding custom rewrite caches while guarding absent `rg` and lossy implicit `wc`/`ls`/`diff` rewrites.
5. **Pre-Rewrite Fast Denial Ordering (PERF-10)**:
   Raw command checks (internal state access and running task log denials) execute before invoking `rtk hook antigravity`, eliminating subprocess overhead for denied commands.
6. **Bounded Query Memory & Raw-Line Prefiltering (PERF-11, PERF-12)**:
   `lib/transcript-core.mjs` (`queryTranscript`) bounds memory using $O(1)$ `CircularRingBuffer` with `matchedCount`, filters plain ASCII keywords cleanly (preserving `truncated_fields` candidates for `mode: "auto"`), and streams large logs with bounded tail reads.

