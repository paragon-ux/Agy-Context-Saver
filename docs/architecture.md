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
- Zero-JSON Markdown transcript extraction (`read_transcript`, `query_transcript`)
- Subagent delegation prompt formulation (`subagent_brief`)
- Benchmark and evaluation artifact mutation protection

---

## Key Technical Subsystems

### 1. Transparent RTK Hook Rewriting
Antigravity's `PreToolUse` hook intercepts `run_command`. Instead of maintaining fragile regexes or custom reducers, Agy invokes `rtk rewrite "<rawCmd>"` (4ms in native Rust):
- If the command is optimizable (`git status`, `pytest`, `cargo test`), RTK exits with 0 or 3 and returns the rewritten command.
- Agy replaces `CommandLine` in the tool invocation arguments.
- If unsupported or already prefixed with `rtk`, the command passes through unchanged (graceful fallback).

### 2. Hard Routing of Native Inspection Tools
Native Antigravity file and search tools (`view_file`, `read_file`, `grep_search`, `find_by_name`, `list_dir`) bypass token reduction:
- Agy denies workspace file inspection and hard-routes the agent to canonical RTK shell commands (`rtk read`, `rtk grep`, `rtk find`, `rtk ls`).
- Documented Antigravity special files (`SKILL.md`, brain artifacts, configuration files) remain accessible through a narrow safe harbor.

### 3. Root-Based Internal State Protection
Regex-based filename filters (`transcript.jsonl`) can be bypassed when new internal files are created. Agy enforces a directory-root guard:
- Any path matching `/.system_generated/` is denied immediately.
- Protects `transcript.jsonl`, `transcript_full.jsonl`, `task-*.log`, progress files, and scheduler state.

### 4. Closed Session-Wide Lifecycle Ledger
Historical loopholes exploited per-task cooldown resets and fuzzy keywords. Agy implements a session-level lifecycle ledger:
- Polling history does NOT reset when changing task IDs, waiting 30 seconds, or interleaving steps.
- Keywords such as "debug", "stuck", or "timeout" do not grant exemptions.
- Long timers (`DurationSeconds >= 120`) do not grant exemptions.
- 5 cumulative denials trigger `force_ask` to halt runaway autonomous loops.

### 5. Benchmark & Evaluator Mutation Protection
During active evaluation sessions, mutating benchmark definitions, prompt templates, or scoring files requires explicit user confirmation via `force_ask`, preventing prompt contamination and benchmark overfitting.

---

## 6. Output Governance & Spillover Safe Harbor (0 New Tools)

To resolve the Output Blind-Spot Trap without bloating the tool registry or taxing model prompts, `Agy-Context-Saver` implements four streamlined output governance pillars:

1. **Safe-Harbor `rtk read` for Runtime Step Spillovers**:
   When Antigravity spills large tool outputs to disk (`.system_generated/steps/<step>/output.txt`), the PreToolUse hook safe-harbors `rtk read <path>`. Native `view_file` calls are automatically routed to `rtk read`, leveraging RTK's native line clamping, head/tail windowing, and token truncation.
2. **Lifecycle-Gated Task Output Inspection**:
   When an agent inspects background task logs (`tasks/<taskId>.log`):
   - While `RUNNING`: Strictly denied under Proportional Backoff to eliminate busy-waiting polling loops.
   - When `COMPLETED` / `TERMINATED`: Allowed via `rtk read` under lifecycle governance for bounded error and stack trace retrieval.
3. **Folded Surgical Step Dereferencing in `query_transcript`**:
   Rather than creating redundant tools, single-step extraction is folded directly into `query_transcript(stepIndex, field)`. Recovers un-truncated payloads from `transcript_full.jsonl` with zero surrounding context bloat.
4. **Pointer-Over-Wire (POW) Subagent Delivery Contract**:
   `subagent_brief` automatically injects the POW protocol into all subagent instructions: research reports $>1\text{ KB}$ are written to workspace files (`scratch/...`), while `send_message` transmits only executive summaries and clickable file links, eliminating in-band message bus truncations.

---

## 7. Performance & Resource Optimization Invariants

1. **Guaranteed Stream Destruction (PERF-01, PERF-02)**:
   All readline and transcript stream readers wrap iteration in `try / finally` with explicit `fileStream.destroy()`. Probe tests verify zero open file descriptor leakage across early exits and line caps.
2. **Subprocess Spawn Elimination (PERF-03)**:
   The PreToolUse hook drops redundant version probes, spawning `rtk rewrite` directly and falling back to plugin binaries only on `ENOENT`, cutting cache miss latency by over 50ms.
3. **Surgical 256KB Tail-Window Task State Resolution (PERF-04, PERF-07)**:
   Task lifecycle checking uses a single unified resolver scanning the last 256KB of `transcript.jsonl` with literal needle matching, reducing inspection time on 10MB transcripts from 123ms to 2ms (-98%).
4. **Atomic Concurrency-Safe Rewrite Caching (PERF-05, PERF-09)**:
   Rewrite caches filter out non-zero exits, spawn errors, and timeouts. Updates re-read disk state to merge concurrent processes and write atomically via temporary files and `renameSync`.
5. **Pre-Rewrite Fast Denial Ordering (PERF-10)**:
   Raw command checks (internal state access and running task log denials) execute before invoking `rtk rewrite`, eliminating subprocess overhead for denied commands.
6. **Bounded Query Memory & Raw-Line Prefiltering (PERF-11, PERF-12)**:
   `query_transcript` bounds memory using a fixed-size ring buffer with `matchedCount`, and filters plain ASCII keywords on the raw line before JSON parsing.

