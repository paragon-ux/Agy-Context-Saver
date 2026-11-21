# Architecture & Internals

`Agy-Context-Saver` (`v2.1.2`) pairs a `PreToolUse` hook (`scripts/execution-guard-hook.mjs`) with a streaming transcript engine (`lib/transcript-core.mjs`, `bin/agy-context.mjs`) and **RTK (`>= 1.1.0`)**, a CLI proxy that compresses noisy shell and test output.

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

---

## Default Session vs. Agy-Context-Saver

![Default Antigravity session vs. Antigravity with Agy-Context-Saver](assets/default-vs-context-saver.svg)

---

## Division of Responsibilities

### RTK (`>= 1.1.0`)
- Compresses noisy test, build, lint, container, and `git status`/`push`/`pull`/`fetch` stdout via the Narrow High-ROI Pre-Gate (`rtk hook antigravity`, configurable via `AGY_RTK_MODE=pregate|off|all`).
- Reads step spillovers and completed task logs (`rtk read`, including `cat` and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrites) and filters command output on demand (`rtk err`, `rtk summary`).

### Agy-Context-Saver (`v2.1.2`)
- Enforces per-task Reactive Wakeup backoff, remote CI timers, and conditioned stall-watchdog auto-clamping on `manage_task` and `schedule` (`30s -> 75s -> 188s -> 469s -> 600s` per task/remote CI; `180s -> 450s -> 600s` per direct subagent), backed by atomic `wx`-locked dual-hook deduplication and a 5-strike `force_ask` circuit breaker.
- Bounds large workspace `read_file` calls (auto-allowing `<= 300` lines & `<= 24 KiB`, safe multimodal media, and special files; allowing bounded slices up to `300` lines and explicit `1..TotalLines` audits up to `800` lines & `45 KiB`) while leaving native `grep_search`, `find_by_name`, and `list_dir` unblocked on workspace paths.
- Protects `.system_generated/` and the state directory (`getStateDir()`, `~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows) across all native file tools (including `multi_replace_file_content`) and symlinks.
- Streams Markdown transcript turns, regex queries, lineage lists, sanitized exports, and step ranges via `agy-context transcript` (`read`, `query`, `step`, `health`, `list`, `export`, `access`).
- Governs child subagent and `/swarm` worker transcript access (including cross-conversation spillovers, task logs, and brain artifacts) via CLI policies, first-line launch directives, and 10-second single-use capability grants.
- Guards benchmark and evaluation files against unapproved edits (`edit_file`, `write_file`, `replace_file_content`, `multi_replace_file_content`, and shell writes), with `AGY_DISABLE_BENCHMARK_GUARD=1` opt-out for top-level non-evaluation repos.

---

## Technical Subsystems

### 1. Narrow High-ROI RTK Pre-Gate (`>= 1.1.0`)
The `PreToolUse` hook intercepts `run_command`. After running internal state, transcript access, and task backoff checks, it evaluates each shell segment before spawning `rtk hook antigravity`:
- High-ROI noisy runners (`pytest`, `python -m pytest`/`mypy`, `uv run pytest`/`ruff`/`mypy`/`ty`, `cargo test`/`build`/`clippy`, `go test`/`build`/`vet`, `vitest`, `jest`, `tsc`, `eslint`, `ruff`, `npm`/`pnpm`/`bun` noisy `run` scripts & `lint`, `docker build`/`ps`/`logs`/`compose ps|logs|build`, `kubectl get`/`logs`/`describe`/`apply`, `git status`/`push`/`pull`/`fetch`) and scoped internal spillover/completed task-log reads receive compact `rtk` rewrites (including inside `bash -c` / `sh -c` / `cmd /c` wrappers and `2>&1`/`2>/dev/null` stderr redirects).
- Precision inspection tools (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, `ps`, `git diff`/`show`/`log`, workspace `cat`/`head`/`tail`), pipes, stdout/file redirects, and machine-readable outputs (`--json`, `--porcelain`, `git status -sb`, `-o json`, etc.) bypass `rtk` completely (zero subprocess spawn, lossless output). Explicit `rtk ...` invocations stay intact, plugin-local off-`PATH` `rtk` (including `uv run rtk ...`) rewrites cleanly, and when host `rg` is absent, bare `rg` maps to lossless `grep` while explicit `rtk rg` maps to `rtk grep`.
- Authorized `agy-context transcript` calls in both `open` and `self-only` modes have `--id <callerConvId>` injected when `--id` is omitted or `current`.
- Unset `WaitMsBeforeAsync` on non-daemon commands is upgraded to `10,000ms` so short commands finish in-turn.

### 2. Workspace File Bounds & Output Inspection
To prevent multi-thousand-line file dumps without obstructing normal exploration:
1. **Native workspace discovery:** `grep_search`, `find_by_name`, and `list_dir` run directly on workspace paths while remaining blocked on `.system_generated/` and `getStateDir()`.
2. **Unified `read_file` / `view_file` bounds:** Small files (`<= 300` lines and `<= 24 KiB`), safe workspace multimodal media (`.png`, `.jpg`, `.webp`, `.pdf`, audio/video), and Antigravity special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, `swarm_view/`, `.gemini/config/`) pass without slice bounds. Larger files accept bounded slices up to `300` lines (EOF-clamped) or explicit full-file audits (`StartLine: 1, EndLine >= TotalLines`) when `<= 800` lines and `<= 45 KiB`. `read_many_files` remains denied.
3. **Spillovers and completed task logs:** Both step output spillovers (`.system_generated/steps/<step>/output.txt`) and completed background task logs (`tasks/<taskId>.log`) allow bounded `read_file` (`<= 150` lines) or single unchained `rtk read <path>` calls once finished (`cat`, and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`; `--head-lines 150` / `--tail-lines 150` required above `45 KiB`; `RUNNING` task logs are always denied).

### 3. Internal State, State Directory & Script Scanning
Segment-, quote-, and heredoc-aware shell parsing protects `.system_generated/` and `getStateDir()`:
- Direct file tool or shell access to `.system_generated/logs/transcript*`, running `tasks/*.log`, `<stateDir>/transcript-access.json`, and `agy-session-*.json` is denied in `PreToolUse`.
- Inline interpreter invocations (`node -e`, `python3 -c`, `bash -c`, `sh -c`) and executable script or heredoc bodies are scanned for references to `.system_generated`, `getStateDir()`, `transcript-core.mjs`, and `bin/agy-context.mjs`.
- When a child session is restricted (`deny` or `self-only`), `.system_generated` denial messages state that transcript access is disabled by parent policy rather than suggesting `agy-context transcript`, avoiding futile retry turns.

### 4. Per-Task Lifecycle Ledger
Polling and watchdog counters are tracked per task and per direct subagent inside `<stateDir>/agy-session-<convId>.json` (`session.taskBackoff[taskKey]`, capped at 64 entries and automatically pruned when `getTaskState()` reports `COMPLETED` or past the 1-hour TTL, with flat `session.pollCount` kept only as a fallback for unkeyed calls):
- Fresh background tasks always start at Level 0 (`0s` immediate Check #1 and `>= 30s` / `45s` conditioned watchdog) without cross-task bleed from earlier tasks.
- Conditioned task watchdogs (`>= 15s`) and conditioned direct-subagent stall watchdogs (`>= 30s`, bound to `TimerCondition="<subagentConvId>"`) auto-clamp via `overwrite: { DurationSeconds: requiredBackoffSec }` instead of stripping monitoring, while abusive micro-polls, unconditioned polling loops, and `/swarm` one-shot timers remain hard-denied.
- Prompt keywords (`debug`, `stuck`, `timeout`) do not bypass backoff rules.
- Reaching 5 cumulative denials across polling, internal state, or transcript access guards triggers `force_ask`, pausing autonomous execution and prompting the user.

---

## Parent Transcript Access Governance

![Parent transcript access precedence and capability grants](assets/transcript-access-governance.svg)

### 1. Control Surfaces: CLI Policy and Launch Directives
- **CLI policy (`agy-context transcript access` / `policy`):** Parents update cohort access via `--status`, `--off` (`--deny-children`), `--on` (`--reset`), `--self-only`, `--mode <open|allowlist|self-only|deny>`, `--allow <id,@roster*...>`, `--deny <id,@roster*...>`, `--ttl <sec>`, and `--json` (plus positional shorthands `status`, `off`, `on`, `reset`, `self-only`).
- **First-line launch directives:** Placing `[agy-transcript-access: deny]`, `[agy-transcript-access: self-only]`, or `[agy-transcript-access: allow]` on the first non-empty line of a `define_subagent` prompt, `invoke_subagent` prompt, or `/swarm` `brief` scopes that child at launch.
- **Prompt-echo immunity:** Lineage parsing inspects only the first non-empty line of the child's initial assignment (`Step 0` / `Step 1`), stripping leading `#` or `>` markers and ignoring directive strings in later paragraphs or code fences.

### 2. 5-Tier Precedence Order
1. **Tier 1 (Policy Owner):** The parent session (`ownerId`) retains unrestricted read and policy mutation access.
2. **Tier 2 (Explicit CLI `--deny`):** Matches `<convId>` or `@<roster-name>` (including prefix globs such as `@worker*`) and denies access.
3. **Tier 3 (Explicit CLI `--allow`):** Matches `<convId>` or `@<roster-name>` (including prefix globs such as `@audit-squad*`) and allows access.
4. **Tier 4 (First-Line Launch Directive):** Applies the child's `[agy-transcript-access: deny|self-only|allow]` header when present.
5. **Tier 5 (Cohort Default Mode):** Falls back to the policy's base mode (`open`, `allowlist`, `self-only`, or `deny`).

### 3. Stale-Lock Protection
To ensure a parent session running `agy-context transcript access --off` never locks out a later top-level user conversation:
1. **Parent-keyed policies with 1-hour TTL:** Policies are stored under `policies[ownerId]` in `<stateDir>/transcript-access.json` with a default 3600-second TTL and pruned automatically when expired.
2. **Top-level `USER_INPUT` bypass and child `sender=` binding:** Top-level user sessions (`Step 0` is `USER_INPUT` with no `<SYSTEM_MESSAGE>` `sender=<parentConvId>` header) bypass foreign parent restrictions, while child subagents and `/swarm` workers bind to their `sender=<parentConvId>` parent policy.
3. **`agy-context status` reporting:** `agy-context status` displays the active policy mode, owner session ID, allow/deny lists, and remaining TTL.

### 4. Single-Use Capability Grants & Path Containment
When `PreToolUse` authorizes a transcript read or policy mutation while a restriction is active, it writes a 10-second single-use atomic grant file under `<stateDir>/grants/`: read grants (`grant-*.json`) bind `callerConvId`, canonical `subcommand`, `targetConvId`, and `mode`, while policy mutation grants (`mut-*.json`) bind `callerConvId`. `verifyTranscriptCoreAccess()` and `manageTranscriptAccessPolicy()` in `lib/transcript-core.mjs` atomically claim (`renameSync`) and verify those fields, and unlink the claimed grant upon path resolution and on any subcommand-matched early error, while `resolveTranscriptPath()` independently restricts `--file` to `<brainDir>/<callerConvId>` in `self-only` mode and `<brainDir>` under any active policy or launch restriction. Together, the hook and CLI provide application-layer defense-in-depth (not an OS-kernel sandbox).

---

## Resource and Streaming Design

- **Stream cleanup:** All `readline` and transcript file streams close inside `try / finally` blocks with explicit `fileStream.destroy()`.
- **Direct hook delegation:** `PreToolUse` spawns `rtk hook antigravity` directly over stdin JSON, falling back to plugin binary paths only on `ENOENT`.
- **256 KB tail-window task resolution:** Task state checks scan the trailing 256 KB of `transcript.jsonl` with literal substring matching before falling back to full-file reads.
- **Fast denial ordering:** Internal state guards, transcript access checks, and running task log denials execute before spawning `rtk hook antigravity`.
- **Bounded query memory & two-tier clamping:** `queryTranscript` in `lib/transcript-core.mjs` bounds memory with an $O(1)$ `CircularRingBuffer`, pre-filters plain ASCII queries before JSON parsing, and hydrates `truncated_fields` from `transcript_full.jsonl` in `auto` mode. Inline defaults across `read`, `outline`, `query`, and `tools` enforce a ~`9.2 KB` inline ceiling (with continuation `nextCursor` hints, collapsed duplicate tool previews, middle-elided paths, and order-independent boilerplate stripping) to stay under `run_command`'s `~10 KB` spillover boundary, while `--full`, `--max-chars`, and `--out` unlock the `512 KB` deep tier and surgical `--line-start`/`--line-end` extraction without intermediate clamp loss.
