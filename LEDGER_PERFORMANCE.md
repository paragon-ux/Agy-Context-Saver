# Agy-Context-Saver Performance Ledger (`LEDGER_PERFORMANCE.md`)

**Scope**: `scripts/execution-guard-hook.mjs` (PreToolUse hook) and `mcp/index.js` (MCP server)  
**Origin**: Performance code review of v1.4.0 (HEAD `07aea9b`), 2026-10-08  
**Status**: RESOLVED (All items addressed: code fixes implemented, benchmark verified, decisions documented).

---

## 1. How to read this ledger

| Priority | Meaning |
| :---: | :--- |
| **P1** | Verified bug or measured cost of 50 ms or more per call. Fix first. |
| **P2** | Measured but small, or a cost that scales with transcript size, or a robustness problem. |
| **P3** | Micro-optimization, trivial, or an unmeasured hypothesis. Measure before acting. |

**Evidence tags**: `MEASURED` (benchmarked on this machine), `VERIFIED` (reproduced with a probe), `READ` (found by reading the code, not run).

**Status**: `[x]` fixed in code, `[closed: decision]` resolved by documented architectural decision, `[closed: measurement]` resolved by benchmark verification.

---

## 2. Baseline vs Post-Optimization Measurements (Windows, Node v22.19.0, rtk 0.50.0)

Largest transcript on test machine: 10.49 MB (7,461 steps). Directory count: 303 conversations.

| Operation | Baseline | Post-Optimization | Notes |
| :--- | ---: | ---: | :--- |
| `node -e ""` (bare process floor) | 75 ms | 72 ms | Process invocation floor on Windows. |
| `rtk --version` | 88 ms | 63 ms | Eliminated from hook invocation path (PERF-03). |
| `rtk rewrite 'git status'` | 145 ms | 123 ms | RTK rewrite subprocess execution. |
| Hook, `run_command`, **cache miss** | **302 ms** | **249 ms** | **-53 ms (-17.5%)** improvement by removing `--version` probe. |
| Hook, `run_command`, cache hit | 101 ms | 113 ms | Near Node startup floor. |
| Hook, builtin fast-path (`echo`) | 99 ms | 104 ms | Regex/Set fast path. |
| Hook, non-governed tool (early allow) | 98 ms | 101 ms | Early exit on unmonitored tools. |
| Transcript task check (10.5 MB) | 123 ms | **2 ms** | **-121 ms (-98%)** via 256KB tail read + literal scan (PERF-04). |
| `query_transcript` memory & streaming | Unbounded | Bounded (<=5 items) | Ring buffer + literal line prefilter (PERF-11, PERF-12). |
| `read_transcript` parsing cost (10.5 MB) | 63 ms | **<5 ms** | Ring buffers raw lines; only parses window (PERF-14). |
| `resolveTranscriptPath("current")` | 19 ms | **<1 ms** | 5s TTL cache + safe per-entry stat (PERF-13). |
| File Descriptor Leak (`ReadStream`) | 20/20 leaked | **0/20 leaked** | Guaranteed `stream.destroy()` in `finally` (PERF-01, PERF-02). |

---

## 3. Findings & Resolutions

### P1: fix first

#### PERF-01: File-descriptor leak in `batchFindFullSteps`
- **Where**: `mcp/index.js` L663–686
- **Evidence**: VERIFIED
- **Resolution**: Added `try { ... } finally { rl.close(); fileStream.destroy(); }`.
- **Gain**: Verified via `fd-probe.mjs`: 0/20 streams held an open fd (was 20/20).
- **Status**: `[x]`

#### PERF-02: Same leak in `handleCheckContextHealth` at the line cap
- **Where**: `mcp/index.js` L314–323
- **Evidence**: VERIFIED
- **Resolution**: Wrapped line iteration in `try / finally` with `fileStream.destroy()`.
- **Status**: `[x]`

#### PERF-03: `rtk --version` probe runs on every uncached hook call
- **Where**: `scripts/execution-guard-hook.mjs` L350–355 (`getRtkBinary`)
- **Evidence**: MEASURED
- **Resolution**: Dropped probe. Hook invokes `rtk rewrite` directly and falls back to plugin binary only on `ENOENT`.
- **Gain**: Cache miss time dropped from 302 ms to 249 ms (-53 ms).
- **Status**: `[x]`

#### PERF-04: Task-state checks read the whole transcript, twice
- **Where**: `scripts/execution-guard-hook.mjs` L268–269 and L319–320
- **Evidence**: MEASURED
- **Resolution**: Reads only the last 256 KB of `transcript.jsonl` (`readTail`) and scans with literal needles. Full file read occurs only if tail is unclosed and markers not found.
- **Gain**: Reduced task inspection from ~123 ms to ~2 ms on 10.5 MB transcript.
- **Status**: `[x]`

---

### P2: measured, small, or scaling

#### PERF-05: Rewrite cache stores failures and timeouts as "no rewrite"
- **Where**: `scripts/execution-guard-hook.mjs` L479–491
- **Evidence**: READ
- **Resolution**: Cache is only updated when `!res.error && !res.signal && res.status >= 0 && res.status <= 3`. Transient failures and timeouts are never cached.
- **Status**: `[x]`

#### PERF-06: Dead session-ledger lookup (`sess.tasks`)
- **Where**: `scripts/execution-guard-hook.mjs` L252–257 and L303–308
- **Evidence**: READ
- **Resolution**: Removed dead `sess.tasks` read/parse branch. Authority unified in `getTaskState()` via transcript markers.
- **Status**: `[x]`

#### PERF-07: `isTaskRunning` and `isTaskCompleted` duplicate their work
- **Where**: `scripts/execution-guard-hook.mjs` L243–293 and L295–345
- **Evidence**: READ
- **Resolution**: Unified into a single `getTaskState(match, convId)` helper returning `RUNNING`, `COMPLETED`, or `UNKNOWN`.
- **Status**: `[x]`

#### PERF-08: Rewrite-cache hit rate is low because keys are exact command strings
- **Where**: `scripts/execution-guard-hook.mjs` L431–491
- **Evidence**: READ
- **Resolution**: Kept exact string keying by deliberate architectural decision. Following PERF-03, a cache miss costs only a single fast spawn (~123 ms). Shape-based keying is unsafe because RTK's rewrite decision depends on command flags and argument syntax.
- **Status**: `[closed: decision]`

#### PERF-09: Rewrite cache is loaded and saved as a whole file, non-atomically
- **Where**: `scripts/execution-guard-hook.mjs` L400–430
- **Evidence**: READ
- **Resolution**: `rememberRewrite(cmd, rewritten)` re-reads disk cache, merges keys, caps to 100 entries, and writes atomically via temporary file and `renameSync`.
- **Status**: `[x]`

#### PERF-10: The `rtk` rewrite runs before the cheap deny checks
- **Where**: `scripts/execution-guard-hook.mjs` L566
- **Evidence**: READ
- **Resolution**: Reordered checks so raw-command gates (internal state checks and running task denials) execute before invoking `rewriteCommandWithRtk`. Denied commands pay 0 subprocess spawns.
- **Status**: `[x]`

#### PERF-11: `query_transcript` keeps every match in memory
- **Where**: `mcp/index.js` L898, L946
- **Evidence**: READ
- **Resolution**: Replaced unbounded array with a ring buffer sized to `effectiveLimit = Math.min(lastTurns || Infinity, maxResults || 5)` plus `matchedCount`.
- **Status**: `[x]`

#### PERF-12: Per-step `JSON.stringify` and no raw-line prefilter in `query_transcript`
- **Where**: `mcp/index.js` L927–943
- **Evidence**: READ
- **Resolution**: Added `isPlainLiteral` raw-line test (`/^[A-Za-z0-9_ -]+$/`). Skips `JSON.parse` on non-matching lines for literal queries.
- **Status**: `[x]`

#### PERF-13: `resolveTranscriptPath("current")` stats every conversation directory
- **Where**: `mcp/index.js` L462–489
- **Evidence**: MEASURED
- **Resolution**: Stats `.../.system_generated/logs/transcript.jsonl` within per-entry `try/catch` and caches the active conversation id for 5 seconds.
- **Status**: `[x]`

---

### P3: micro, trivial, or unmeasured

#### PERF-14: `read_transcript` parses every line to keep a window of about 100
- **Where**: `mcp/index.js` L693–720
- **Evidence**: MEASURED
- **Resolution**: Buffers raw string lines into a sliding window of `WINDOW_SIZE`, and runs `JSON.parse` only on the retained slice at the end.
- **Status**: `[x]`

#### PERF-15: `cleanMessageContent` runs its regexes before truncating
- **Where**: `mcp/index.js` L535–570
- **Evidence**: READ
- **Resolution**: Pre-slices oversized text to `maxChars * 4` before executing base64 regex and line-clamping logic.
- **Status**: `[x]`

#### PERF-16: `check_context_health` parses every line to count types
- **Where**: `mcp/index.js` L316–343
- **Evidence**: READ
- **Resolution**: Uses prefix string check for `USER_INPUT` / `PLANNER_RESPONSE` on lines without `"tool_calls"`, skipping `JSON.parse`.
- **Status**: `[x]`

#### PERF-17: `existsSync` followed by open or read (extra syscall, race)
- **Where**: `mcp/index.js` L665, L801, L891; hook L66–70, L89
- **Evidence**: READ
- **Resolution**: Dropped redundant `existsSync` before stream opens and file reads, relying on `try/catch`. Lazy check for `fullSiblingPath`.
- **Status**: `[x]`

#### PERF-18: Unescaped task id in a dynamic `RegExp`
- **Where**: `scripts/execution-guard-hook.mjs` L269 and L320
- **Evidence**: READ
- **Resolution**: Replaced dynamic regex compilation with literal `includes()` scanning in `scanTaskMarkers`.
- **Status**: `[x]`

#### PERF-19: Repeated path normalization and duplicate checks per call
- **Where**: `scripts/execution-guard-hook.mjs` L124–210
- **Evidence**: READ
- **Resolution**: Combined internal state regex patterns and added fast-path prechecks before heavy inspection.
- **Status**: `[x]`

#### PERF-20: Process-start floor (75 ms)
- **Where**: Hook entry
- **Evidence**: MEASURED
- **Measurement**: Tested `NODE_COMPILE_CACHE` in `bench2.mjs`: warm cache was 111.0 ms vs 105.0 ms un-cached (cache stat/validation overhead exceeds bytecode compile savings for 36KB script).
- **Status**: `[closed: measurement]`

#### PERF-21: `readline` `for await` overhead vs manual chunk splitting
- **Where**: `mcp/index.js` streaming loops
- **Evidence**: MEASURED
- **Measurement**: Tested in `bench2.mjs` on 10.49 MB transcript: manual chunk split + parse was 160.8 ms vs readline + parse 155.1 ms (-4% gain). Standard `readline` with proper stream cleanup (`stream.destroy()`) is cleaner and faster when JSON parsing is involved.
- **Status**: `[closed: measurement]`

---

## 4. Governance & Configuration Items

#### OBS-A: File-mutation guard (LH-09) matcher in installed hook
- **Where**: `scripts/install-register.mjs`, `hooks.json`, `tests/test-installed-verification.mjs`
- **Resolution**: Added `replace_file_content|write_to_file` to hook matchers in both `hooks.json` and `scripts/install-register.mjs`. Updated `test-installed-verification.mjs` to assert their presence.
- **Status**: `[x]`

#### OBS-B: Task-log gating treats a silent task as finished
- **Where**: `scripts/execution-guard-hook.mjs` task state resolver
- **Resolution**: In `getTaskState`, transcript start notice without a finish notice maintains `RUNNING` status regardless of elapsed log quiet time. Mtime fallback is only used for stale tasks (>5 minutes) with no transcript markers. Verified with automated regression test in `test-output-governance.mjs`.
- **Status**: `[x]`
