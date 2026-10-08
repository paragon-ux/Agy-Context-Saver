# Changelog

All notable changes to `Agy-Context-Saver` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
