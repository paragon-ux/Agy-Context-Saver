# Changelog

All notable changes to `Agy-Context-Saver` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
