# Changelog

All notable changes to `Agy-Context-Saver` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Performance & Memory Optimizations
- **File-Descriptor Leak Fixes (PERF-01, PERF-02)**: Ensured guaranteed stream destruction via `finally { rl.close(); fileStream.destroy(); }` across `batchFindFullSteps`, `handleCheckContextHealth`, `handleReadTranscript`, and `handleQueryTranscript`, eliminating open handle leaks on early exits and line caps (verified 0/20 leaked).
- **Subprocess Call Reduction in PreToolUse Hook (PERF-03)**: Dropped redundant `rtk --version` probe in hook initialization; executes `rtk rewrite` directly and falls back to plugin binary only on `ENOENT`, reducing cache miss latency from 302ms to 249ms (-17.5%).
- **Surgical Tail-Window Task State Resolution (PERF-04, PERF-07)**: Unified task lifecycle checking into a single `getTaskState()` reading the last 256KB tail of `transcript.jsonl` with literal needle matching (`scanTaskMarkers`), dropping check latency from 123ms to 2ms on 10.5MB transcripts (-98%).
- **Atomic Concurrency-Safe Rewrite Cache (PERF-05, PERF-09)**: Rewrite cache now filters out timeouts and non-zero/non-clean exit codes, re-reads disk state to merge concurrent updates, and persists atomically via temporary files.
- **Pre-Rewrite Fast Denial Ordering (PERF-10)**: Reordered command checks so raw-command gates (internal state access and running task log denials) execute before invoking `rtk rewrite`, eliminating subprocess overhead for denied commands.
- **Bounded Query Memory & Raw-Line Prefilter (PERF-11, PERF-12)**: Implemented ring-buffered step retention bounded by `effectiveLimit` with `matchedCount` in `query_transcript`, and added raw-line ASCII substring pre-filtering to skip `JSON.parse` on non-matching lines.
- **Active Conversation Resolution Cache (PERF-13)**: Cached `resolveTranscriptPath("current")` lookups for 5s and implemented resilient per-entry directory stats.
- **Sliding-Window Parsing & String Pre-Slicing (PERF-14, PERF-15, PERF-16)**: `read_transcript` now streams raw lines and only parses retained turns; `cleanMessageContent` pre-slices oversized payloads to `4 * maxChars` before running regexes; `check_context_health` skips parsing for steps without tool calls.
- **Redundant Syscall Elimination (PERF-17, PERF-18, PERF-19)**: Removed unnecessary `existsSync` checks before reads and replaced dynamic task id regexes with literal string searching.

### Governance & Configuration Hardening
- **Installed Hook Matcher Inclusion (OBS-A)**: Added `replace_file_content|write_to_file` to hook matchers in `hooks.json` and `scripts/install-register.mjs`, ensuring benchmark mutation guards (LH-09) are wired in installed environments.
- **Transcript Authority for Silent Running Tasks (OBS-B)**: Updated task state resolver to treat background tasks with start notices as actively `RUNNING` regardless of log quiet duration until an explicit finish notice appears, preventing premature inspection of quiet background jobs.

---

## [1.4.0] - 2026-10-08

### Added (Output Inspection Governance & Forensic Dereferencing - LH-12)
- **Folded Surgical Step Dereferencing in `query_transcript` (NFF-05)**: Added optional `stepIndex` (number) and `field` (string) parameters to `query_transcript`, allowing surgical single-step extraction from `transcript_full.jsonl` without creating redundant tools. Recovers un-truncated subagent messages and arguments with zero surrounding context bloat.
- **Safe-Harbor `rtk read` for Step Output Spillovers (NFF-01 & NFF-02)**: Provided a safe harbor in `execution-guard-hook.mjs` allowing `rtk read` on runtime step output spillovers (`.system_generated/steps/<step>/output.txt`). Native `view_file` and shell `cat` invocations are automatically routed to `rtk read <path>`, leveraging `rtk read`'s built-in line clamping, head/tail windowing, and token truncation.
- **Lifecycle-Gated Task Output Inspection (NFF-03)**: Added lifecycle governance for background task logs (`tasks/<taskId>.log`) in `execution-guard-hook.mjs`. Invocations are strictly **denied** under Proportional Backoff while tasks are `RUNNING` to stop polling loops, but allowed via `rtk read` once `COMPLETED` / `TERMINATED` for bounded stack trace and failure inspection.
- **Pointer-Over-Wire (POW) Subagent Contract (NFF-06)**: Integrated the POW protocol into `subagent_brief`. Research findings $>1\text{ KB}$ are written to workspace artifacts (`scratch/...`), while `send_message` transmits only executive summaries and clickable file links, preventing message bus truncations.
- **Output Governance Test Suite**: Added `tests/test-output-governance.mjs` verifying spillover safe-harbor access, task output lifecycle gating, forensic step extraction, and hook routing.

### Changed
- **Streamlined Tool Architecture (0 New Tools)**: Eliminated tool proliferation by consolidating capabilities into existing tools and hooks, maintaining strictly the 6 core canonical MCP tools (zero prompt token bloat, zero tool-selection ambiguity).
- **Typed Argument Descriptors (NFF-04)**: Replaced blind `JSON.stringify().slice(0, 80)` in `formatTranscriptItem()` with typed argument descriptors (`[14.2 KB String]`, `[Array(5)]`, `{Object(3 keys)}`), preserving JSON payload integrity and transcript legibility.

---

## [1.3.2] - 2026-10-07

### Governance & Command Semantics (LH-11 Hardening)
- **Opt-In Fail-Fast Semantics**: Reverted forced `-x -q` parameter injection on bare test runner invocations to preserve native command semantics. Fail-fast (`-x`, `--maxfail=1`) remains strictly opt-in, preventing the "whack-a-mole" repair loop and preserving complete failure blast radius visibility across multi-module test suites.
- **Architectural Separation**: Replaced forced command mutation with the **Coordinated Watchdog Protocol** and **Mandatory Pre-Yield Status Cards** in `rules/AGENTS.md`, ensuring visibility during multi-minute full-repository sweeps without distorting test results.
- **Loophole Ledger Synchronization**: Updated `LEDGER.md` (LH-11) documenting the trade-offs of fail-fast injection vs native command semantics.

---

## [1.3.1] - 2026-10-07

### Governance & Asynchronous Execution Observability (LH-11)
- **Fail-Fast Auto-Injection on Bare Test Sweeps**: `execution-guard-hook.mjs` transparently normalizes bare `pytest` and `python -m pytest` invocations to include `-x -q` (fail-fast, quiet mode). In large codebases (e.g. 900+ tests), this prevents multi-minute unconstrained sweeps by stopping execution immediately at the first failure.
- **Coordinated Watchdog Protocol Codification**: Updated `rules/AGENTS.md` to explicitly train agents on the Coordinated Watchdog Protocol: when launching heavy background operations ($> 15\text{s}$), agents must schedule a coordinated watchdog timer (`schedule(DurationSeconds=45, ...)`) to prevent silent yielding into unmonitored execution black holes.
- **Mandatory Pre-Yield Status Cards**: Codified in `rules/AGENTS.md` that agents launching background tasks must output a structured markdown status card (command, scope, estimated duration, watchdog tier) before yielding their turn, eliminating user uncertainty during prolonged runs.
- **Loophole Ledger LH-11 Addition**: Formally documented LH-11 (Silent Background Deadlock & Bare Sweep Exhaustion) from Incident `07b0f8d8` in `LEDGER.md`.

---

## [1.3.0] - 2026-10-07

### Governance & Loophole Elimination
- **Proportional Backoff Engine**: Eliminated the "Pendulum Freeze Trap" (where total bans on task polling caused hung/deadlocked background commands to run unmonitored forever) by implementing an exponential backoff curve ($0\text{s} \to 30\text{s} \to 75\text{s} \to 188\text{s} \to 469\text{s} \to 600\text{s}$). Tasks can be safely diagnosed when silent without enabling busy-waiting loops.
- **Watchdog Timer Coordination**: Coordinated `schedule` watchdog timers with the active proportional backoff window. Timers shorter than the backoff cooldown are rejected with detailed feedback, while legitimate watchdog timers ($\ge 30\text{s}$) are permitted and auto-cancel via native Reactive Wakeup.
- **Shell Wrapper Unwrapping (LH-01-B)**: Added recursive shell wrapper unwrapping (`cmd /c`, `powershell -Command`, `pwsh -c`, `bash -c`) inside `run_command` so wrapped commands are transparently rewritten to RTK equivalents instead of bypassing token optimization.
- **Internal State Shell Guard (LH-02-B)**: Added strict shell command guards blocking direct shell access (`cat`, `Get-Content`, `type`) to internal Antigravity execution state (`.system_generated/`), routing transcript queries to MCP tools.
- **Benchmark Shell Mutation Protection (LH-09-B)**: Extended benchmark and evaluator protections to shell redirect and removal operations (`>`, `rm`, `del`, `Remove-Item`), preventing benchmark tampering via the terminal.
- **Single Source of Truth Ledger**: Authored comprehensive `LEDGER.md` tracking all 10 historical loopholes (LH-01 to LH-10), remnant escape routes, backoff mathematical formulas, and architectural invariants.

---

## [1.2.1] - 2026-10-07

### Documentation & Developer Experience
- **MCP Prompts Documentation**: Formally documented the `/mcp:agy-context-saver:context_shield` prompt across `README.md` and the documentation site, clarifying the operational difference between user slash commands (Prompts) and autonomous agent capabilities (Tools).
- **Quickstart Optimization**: Repositioned the Quickstart installation block to the very top of `README.md` and `docs/index.md` for immediate onboarding.
- **Zensical Docs Site Overhaul**: Added `context_shield` reference and tip callouts across `docs/index.md`, `docs/tools.md`, and `docs/governance.md`; updated navigation title to `Tools & Prompts`.
- **Dynamic Test Assertions**: Updated installed MCP server verification test to dynamically synchronize with `package.json` version.

---

## [1.2.0] - 2026-10-07

### Performance & Forensics
- **Batch Full-Transcript Dereferencing**: Replaced sequential full-transcript scans with `batchFindFullSteps()`, reducing $N$-item dereferencing from $O(N)$ full-file passes down to a single streaming pass ($O(1)$) in 18.4ms.
- **Sliding-Window Turn Retention**: Bounded transcript memory retention in `read_transcript` (`WINDOW_SIZE = Math.max(100, lastTurns * 15)`) with an early-stopping block formatter, parsing 2,000 steps in 21.8ms under 24 KB memory.
- **Regex LRU Caching**: Added in-memory LRU cache (`regexCache`, capacity: 100) for query pattern compilation in `query_transcript`.
- **Short-Circuit Field Search**: Converted transcript search to test fields sequentially (`content` $\to$ `thinking` $\to$ `tool_calls`), avoiding heavy string concatenations.
- **Fast-Path Message Cleaning**: Added fast-path bypass in `cleanMessageContent` for strings $\le 120$ characters, eliminating redundant base64 regexes and newline splits.
- **Static Rules In-Memory Cache**: Cached `rules/AGENTS.md` in memory with `mtimeMs` file stat invalidation, eliminating disk I/O on `resources/read` and `prompts/get`.

### Execution Governor & Hook
- **Fast-Path Builtin Bypass**: Added `NON_REWRITABLE_BINARIES` set (`node`, `powershell`, `pwsh`, `cmd`, `dir`, `echo`, `cd`, `del`, etc.) and PowerShell cmdlet prefixes to bypass `spawnSync("rtk")`, dropping execution latency from ~30ms to $< 0.05$ms.
- **Persistent Command Rewrite LRU Cache**: Implemented persistent disk LRU cache (`agy-rtk-rewrite-cache.json` in `os.tmpdir()`) for rewritable commands, reducing repeat rewrite lookups to $< 0.1$ms.
- **Session Ledger State Partitioning**: Partitioned session state by conversation ID (`agy-session-${safeId}.json`) to eliminate cross-session file contention.

### Registration & Lifecycle
- **Idempotent Config & Schema Synchronization**: Added `safeWriteFileIfChanged` and `safeCopyFileIfChanged` across all configuration (`hooks.json`, `mcp_config.json`) and MCP tool schemas (`~/.gemini/antigravity/mcp/agy-context-saver/`), eliminating disk churn during repeat syncs.
- **RTK Provisioning Check Reuse**: Passed pre-detected RTK metadata to `ensureRtkInstalled()` to eliminate redundant `execSync` version checks during installation.

### Security & Reliability
- **Stdio Payload Safety Ceiling**: Added 10 MB payload guard (`MAX_STDIO_PAYLOAD_BYTES`) on the MCP stdio line reader, emitting standard JSON-RPC `-32600 Invalid Request` on oversized payloads.
- **New Performance Verification Suite**: Added `tests/test-performance-probes.mjs` verifying batch dereferencing, sliding window bounds, stdio safety ceiling, and idempotent writes.

---

## [1.1.0] - 2026-10-07

### Added
- **Closed Execution Topology & Governance Invariants**: Comprehensive PreToolUse hook intercepting native inspection tools (`view_file`, `grep_search`, `list_dir`, `find_by_name`) and hard-routing them to RTK.
- **Root-Based Antigravity State Protection**: Denied direct access to `.system_generated/` internal files to prevent transcript bloat and loop degradation.
- **Session-Wide Lifecycle Ledger**: Non-resettable session task polling counter with Tier 3 `force_ask` circuit breaker at 5 denials.
- **Evaluator & Benchmark Mutation Safeguard**: Gated mutation of evaluator or benchmark artifacts behind user confirmation.
- **Platform-Aware Windows Routing**: Windows-native routing for `rtk rg "<pattern>" .` and `rtk find <path>` to eliminate stdin hangs.
- **Universal MCP Server**: 6 core tools (`check_context_health`, `subagent_brief`, `get_installation_status`, `sync_installation`, `read_transcript`, `query_transcript`).

---

## [1.0.0] - 2026-10-07

### Initial Release
- Initial release of Agy-Context-Saver.
- Antigravity Model Context Protocol (MCP) server.
- Background task lifecycle governance and reactive wakeup enforcement.
