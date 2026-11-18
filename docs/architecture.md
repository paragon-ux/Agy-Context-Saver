# Architecture & Internals

`Agy-Context-Saver` (`v2.0.x`) pairs a `PreToolUse` hook (`scripts/execution-guard-hook.mjs`) with a streaming transcript engine (`lib/transcript-core.mjs`, `bin/agy-context.mjs`) and **RTK (`>= 1.1.0`)**.

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

---

## Division of Responsibilities

### RTK (`>= 1.1.0`)
- Rewrites supported shell commands via `rtk hook antigravity` (`git`, `pytest`, `cargo`, `npm`, `tsc`, `docker`, and linters).
- Searches and lists workspace files (`rtk grep`, `rtk find`, `rtk ls`, `rtk tree`, `rtk read`).
- Filters command output to errors or summaries (`rtk err`, `rtk summary`).

### Agy-Context-Saver (`v2.0.x`)
- Enforces Reactive Wakeup backoff on `manage_task` and `schedule`, backed by a 5-strike `force_ask` circuit breaker.
- Bounds workspace `read_file` slices (`<= 150` lines, or explicit `1..TotalLines` reads on files `<= 800` lines and `<= 45 KiB`).
- Protects `.system_generated/` and the state directory (`getStateDir()`, `~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows).
- Streams Markdown transcript turns, regex queries, lineage lists, sanitized exports, and step ranges via `agy-context transcript` (`read`, `query`, `step`, `health`, `list`, `export`, `access`).
- Governs child subagent and `/swarm` worker transcript access via CLI policies, first-line launch directives, and 10-second single-use capability grants.
- Guards benchmark and evaluation files against unapproved edits (`edit_file`, `write_file`, and shell writes).

---

## Technical Subsystems

### 1. RTK `>= 1.1.0` Hook Delegation
The `PreToolUse` hook intercepts `run_command`. After running internal state, transcript access, and task backoff checks, it passes the command payload to `rtk hook antigravity` over stdin JSON:
- Supported commands (`git status`, `pytest`, `cargo test`) receive an updated `CommandLine` rewrite (`rtk git`, `rtk pytest`, or `bash -c 'rtk ...'`).
- Authorized `agy-context transcript` calls under `self-only` governance have `--id <callerConvId>` injected before execution so the child session can only read its own transcript.
- Implicit `wc`, `ls`, and `diff` rewrites that would alter output format are reverted unless explicitly invoked as `rtk ...`. When host `rg` is absent, `rg` commands fall back to `rtk grep`.
- Unset `WaitMsBeforeAsync` on non-daemon commands is upgraded to `10,000ms` so short commands finish in-turn.

### 2. 3-Tier Workspace File Inspection
To prevent multi-thousand-line file dumps while keeping exact 1-indexed line numbers for `edit_file` and `write_file`:
1. **Tier 1 (Search and discovery):** `rtk grep`, `rtk find`, and `rtk ls` locate target files and `[StartLine, EndLine]` ranges.
2. **Tier 2 (Bounded `read_file` slices):** `read_file` calls pass `StartLine` and `EndLine` (`1-150` lines, or `1..TotalLines` when a file is `<= 800` lines and `<= 45 KiB`). Antigravity special files (`SKILL.md`, `AGENTS.md`, brain artifacts, `swarm_view/` narrator state, `.gemini/config/`) pass through Safe Harbor without slice bounds.
3. **Tier 3 (Spillovers and task logs):** Step output spillovers (`.system_generated/steps/<step>/output.txt`) allow bounded `read_file` (`<= 150` lines) or single unchained `rtk read <path>` calls. Completed background task logs (`tasks/<taskId>.log`) allow single unchained `rtk read` calls once the task has finished.

### 3. Internal State, State Directory & Script Scanning
Segment-, quote-, and heredoc-aware shell parsing protects `.system_generated/` and `getStateDir()`:
- Direct file tool or shell access to `.system_generated/logs/transcript*`, running `tasks/*.log`, `<stateDir>/transcript-access.json`, and `agy-session-*.json` is denied in `PreToolUse`.
- Inline interpreter invocations (`node -e`, `python3 -c`, `bash -c`, `sh -c`) and executable script or heredoc bodies are scanned for references to `.system_generated`, `getStateDir()`, `transcript-core.mjs`, and `bin/agy-context.mjs`.
- When a child session is restricted (`deny` or `self-only`), `.system_generated` denial messages state that transcript access is disabled by parent policy rather than suggesting `agy-context transcript`, avoiding futile retry turns.

### 4. Session-Wide Lifecycle Ledger
Polling counters are tracked per session in `<stateDir>/agy-session-governance-state.json`:
- Counters persist across task ID changes, pauses, and interleaved tool calls.
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
When `PreToolUse` authorizes a transcript read or policy mutation while a restriction is active, it writes a 10-second single-use token to `<stateDir>/transcript-access.json`: read grants (`lastHookGrant`) bind `callerConvId`, canonical `subcommand`, `targetConvId`, and `mode`, while policy mutation grants (`lastAccessMutationGrant`) bind `callerConvId`. `verifyTranscriptCoreAccess()` and `manageTranscriptAccessPolicy()` in `lib/transcript-core.mjs` verify those fields, clear the disk token on verification, and clear the in-memory grant synchronously upon path resolution (before async stream I/O begins) and on any early error, while `resolveTranscriptPath()` independently restricts `--file` to `<brainDir>/<callerConvId>` in `self-only` mode and `<brainDir>` under any active policy or launch restriction. Together, the hook and CLI provide application-layer defense-in-depth (not an OS-kernel sandbox).

---

## Resource and Streaming Design

- **Stream cleanup:** All `readline` and transcript file streams close inside `try / finally` blocks with explicit `fileStream.destroy()`.
- **Direct hook delegation:** `PreToolUse` spawns `rtk hook antigravity` directly over stdin JSON, falling back to plugin binary paths only on `ENOENT`.
- **256 KB tail-window task resolution:** Task state checks scan the trailing 256 KB of `transcript.jsonl` with literal substring matching before falling back to full-file reads.
- **Fast denial ordering:** Internal state guards, transcript access checks, and running task log denials execute before spawning `rtk hook antigravity`.
- **Bounded query memory & two-tier clamping:** `queryTranscript` in `lib/transcript-core.mjs` bounds memory with an $O(1)$ `CircularRingBuffer`, pre-filters plain ASCII queries before JSON parsing, and hydrates `truncated_fields` from `transcript_full.jsonl` in `auto` mode. Inline defaults across `read`, `outline`, `query`, and `tools` enforce a ~`9.2 KB` inline ceiling (with continuation `nextCursor` hints, collapsed duplicate tool previews, middle-elided paths, and order-independent boilerplate stripping) to stay under `run_command`'s `~10 KB` spillover boundary, while `--full`, `--max-chars`, and `--out` unlock the `512 KB` deep tier and surgical `--line-start`/`--line-end` extraction without intermediate clamp loss.
