---
name: context-governance
description: >-
  Use when running shell commands with large outputs, inspecting session transcript health
  via agy-context, preventing repetitive background polling loops, or inspecting codebases with RTK.
---

# Context Governance & Execution Guard (Agy-Context-Saver + RTK)

`Agy-Context-Saver` and `RTK` compress shell output, enforce bounded workspace file reads, stop background-task busy-polling, and provide CLI commands for conversation transcript inspection and access control.

## Architectural Boundary

- **RTK (`>= 1.1.0`)**: Rewrites shell commands (`rtk hook antigravity`), compresses command output, provides workspace search and file listing (`rtk grep`, `rtk find`, `rtk ls`), reads spillovers and completed task logs (`rtk read`), and filters errors or summaries (`rtk err`, `rtk summary`).
- **Agy-Context-Saver (`v2.0.4`)**: Enforces Reactive Wakeup backoff, bounds `read_file` slices, protects `.system_generated/` and the state directory, and exposes two-tier `agy-context transcript` (`~9.2 KB` inline defaults + `--full`/`--out` `512 KB` deep mode).

---

## Workspace File & Codebase Inspection

Unbounded full-file `read_file` calls on workspace files are blocked by the `PreToolUse` hook:

1. **Tier 1 (Search and discovery: `rtk grep`, `rtk find`, `rtk ls`)**:
   - **Pattern and symbol search**: Run `rtk grep -rnE "<pattern>" <path>` via `run_command` to locate `[StartLine, EndLine]` coordinates (always pass an explicit target path such as `.` or `src/` so `rtk grep` does not wait on stdin). Because `rtk grep` clips lines at `~80` chars and `25` matches/file (emitting ephemeral `rtk recall` hashes unreadable from transcripts), implicit `grep` commands stay unrewritten (`ACS-HOOK-09`); use raw `grep -rnE` whenever untruncated lines or `>25` matches per file are required.
   - **Directory and file listing**: Run `rtk find <path>`, `rtk ls <path>`, or `rtk tree` (or PowerShell `dir` / `Get-ChildItem` on Windows).
2. **Tier 2 (Workspace file reading: `read_file` slice policy)**:
   - Pass `StartLine` and `EndLine` into `read_file` in bounded slices of `1-150` lines to preserve 1-indexed line numbers for `edit_file` and `write_file`.
   - Partial slices of `151-800` lines and `ByteOffset`-only unbounded reads are denied. An explicit full-file read (`StartLine: 1, EndLine: <TotalLines>`) is allowed when the file on disk is $\le 800$ lines and $\le 45\text{ KiB}$ (`46,080` bytes).
3. **Tier 3 (Spillovers, completed task logs, and diagnostics: `rtk read`, `rtk err`, `rtk summary`)**:
   - **Spillovers and completed task logs only**: Read `.system_generated/steps/<step>/output.txt` spillovers (via bounded `read_file` $\le 150$ lines or `rtk read <path>`) and completed `tasks/<taskId>.log` files via `rtk read <path>` (`cat`, and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`; use explicit `rtk read <path>` for bare `tail`, quoted/spaced paths, Windows backslash `head`/`tail`, or env prefixes, and `--head-lines 150` / `--tail-lines 150` required on `>45 KiB` files). Never use `rtk read` for editable workspace code; use bounded `read_file` slices so 1-indexed line numbers stay exact for `edit_file` (when denied on `read_many_files`, use bounded `read_file` for editable code or `rtk read` for read-only logs/spillovers).
   - `rtk err <cmd>`: Runs a command and prints only errors and warnings.
   - `rtk summary <cmd>`: Runs a command and prints a 2-line summary.

*Safe harbor*: Antigravity special files (`SKILL.md`, `AGENTS.md`, brain artifacts, `swarm_view/` narrator state, `.gemini/config/`) may be read via `read_file` without slice bounds, and `.system_generated/steps/<n>/output.txt` supports bounded `read_file` ($\le 150$ lines).

---

## `agy-context` CLI Commands

Run `agy-context` via `run_command` (`~/.gemini/antigravity/bin/agy-context`). Invoke `agy-context transcript ...` as a single unchained command without `&&`, `||`, `;`, `|`, or redirects:

### 1. `agy-context transcript health` (aliases: `stats`, `info`)
Checks turn counts, step counts, raw transcript size, RTK status, and busy-polling events.
```bash
agy-context transcript health [<id>] [--id <conv>] [--json] [--file <path>]
```

### 2. `agy-context transcript read`
Streams recent conversation turns in Markdown (default ~`9.2 KB` inline ceiling with `nextCursor` hints), delegates to `query --summary --include-tools` when `--outline` is passed, or opts into the `512 KB` deep tier via `--full`/`--out`.
```bash
agy-context transcript read [<id>] [--id <conv>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--outline] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

### 3. `agy-context transcript query` (aliases: `grep`, `search`, `find`, `tools`, `outline`, `summary`)
Searches transcripts by regex or substring with automatic dereferencing of truncated fields, role filtering (`user`, `assistant`, `subagent`, `tool`, `generic`, `system`, `error`, `all`), and `--full-args` / `--field` projection. Default inline outputs stay within ~`9.2 KB` (`date=YYYY-MM-DD UTC` header compaction, duplicate tool collapse `(xN)`, boilerplate stripping with `[spill: steps/<N>]`, and compact `{ step_index, type, role, created_at, status, summary }` items on `--summary`/`outline --json`); `--full`, `--max-chars`, or `--out` opts into `512 KB`. The `tools` alias defaults to `--roles assistant --field tool_args --include-tools`, and `outline` / `summary` map to `query --summary --include-tools`.
- **Multi-step forensic workflow**:
  1. `agy-context transcript outline [<conv>] --start 0 --end 100` (1-line-per-step index with `[ERROR]`, `[spill: steps/<N>]`, and `[tools: ...]` tags)
  2. `agy-context transcript tools --id <conv> --start 0 --end 100` (tool call arguments; add `--full` or `--out` for large batches)
  3. `agy-context transcript step <N,M,K|N-M> [<conv>] --field content` (batch-extract specific step outputs without 1-by-1 `--step <N>` loops)
```bash
agy-context transcript query [<pattern>] [<id>] [--id <conv>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

### 4. `agy-context transcript step`
Extracts untruncated content or specific fields (`content`, `thinking`, `tool_calls`, `tool_args`, `tool_args:<Key>`, `all`) for one step or a batch/range of steps (`2,8,14`, `2-10`, `2..10`, or `--start 2 --end 10`) from `transcript_full.jsonl`, with optional `--head <N>`, `--tail <N>`, `--line-start <N>`..`--line-end <N>`, `--max-chars <N>`, `--out <path>`, and `--full` (`512 KB` unclamped mode).
```bash
agy-context transcript step [<N|N,M|N-M|N..M>] [<id>] [--id <conv>] (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--head N] [--tail N] [--line-start N] [--line-end N] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

### 5. `agy-context transcript list` (alias: `ls`)
Lists recent conversations across Antigravity's brain roots (`~/.gemini/antigravity/brain`, `~/.gemini/antigravity-cli/brain`, `~/.gemini/antigravity-ide/brain`) sorted by modification time, with optional `--parent <uuid>` filtering and `--lineage` metadata.
```bash
agy-context transcript list [--limit N] [--parent <uuid>] [--lineage] [--json]
```

### 6. `agy-context transcript export` (alias: `dump`)
Exports an `L6`-safe sanitized conversation transcript summary (`--sanitized` is required to redact tool payload bodies and secrets for safe sharing or restricted child review), keeping stdout within ~`9.2 KB` inline unless `--full` or `--out`/`--output <path>` unlocks the `512 KB` deep tier (`--max-chars` overrides up to `524,288` bytes).
```bash
agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--full] [--max-chars N] [--out|--output <path>] [--file <path>] [--json]
```

### 7. `agy-context transcript access` (alias: `policy`)
Controls parent transcript access policies for child subagents and `/swarm` workers.
```bash
agy-context transcript access [status|off|on|reset|self-only] [--status | --off (--deny-children) | --on (--reset) | --self-only | --mode <open|allowlist|self-only|deny> | --allow <id,@roster*...> | --deny <id,@roster*...> | --ttl <sec>] [--json]
```
- **First-line launch directives**: Place `[agy-transcript-access: deny]`, `[agy-transcript-access: self-only]`, or `[agy-transcript-access: allow]` on the first non-empty line of a `define_subagent` `SystemPrompt`, `invoke_subagent` `Prompt`, or `/swarm` worker `brief` (later lines and code blocks are ignored).
- **5-tier precedence**: `1. Policy Owner` -> `2. Explicit CLI --deny` -> `3. Explicit CLI --allow` (supports `@roster*` prefix globs such as `@audit-squad*`) -> `4. First-Line Launch Directive` -> `5. Cohort Default Mode`.
- **Stale-lock protection & immutable Tier 4 disclosure**: Parent CLI policies (`policies[ownerId]`) expire after a 1-hour default TTL (`--on`/`--reset` clears only parent overrides while immutable Tier 4 `deny`/`self-only` launch directives remain enforced), Step 0 `USER_INPUT` top-level user sessions bypass child locks automatically, Step 0/1 `sender=<parentConvId>` binds child agents to their parent policy, and both `agy-context transcript access --status` and `agy-context status` disclose active `launchRestrictions` alongside the parent CLI policy.

### 8. `agy-context status`, `setup`, `uninstall` & `restore-backups`
Audits, synchronizes, removes, or restores backups for the plugin link, `PreToolUse` hook, CLI shims, RTK (`>= 1.1.0`), and `Transcript Access Policy` (run `uninstall` or `restore-backups` only when explicitly requested by the user).
```bash
agy-context status [--json]
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
agy-context restore-backups
```

---

## Governance Summary

1. **Layer 1 (Reactive lifecycle and backoff)**:
   - Do not busy-wait on `manage_task(Action='status')` or short polling timers; end the turn and wait for Reactive Wakeup (`<SYSTEM_MESSAGE>`).
   - Do not run blocking CI watch loops (`gh pr checks --watch`, `gh run watch`) inside `run_command`; use one-shot snapshots (`gh pr checks`, `gh run list`) instead.
   - Status checks follow exponential backoff: $\min(600, \text{round}(30 \times 2.5^{\text{pollCount}-1}))$. 5 cumulative denials trigger the `force_ask` circuit breaker.
   - For background shell tasks $>15\text{s}$, schedule `schedule(DurationSeconds=45, TimerCondition="<convId>/task-X")` and output a Pre-Yield Status Card. Never pair `swarm_wait` or subagents with a one-shot `schedule` timer.
2. **Layer 2 (Shell rewriting, file slices, and transcript access)**:
   - Shell commands rewrite via `rtk hook antigravity`.
   - Workspace inspection uses `rtk grep` / `rtk find` -> bounded `read_file(StartLine, EndLine)` -> `edit_file` / `write_file`, while `rtk read` reads step spillovers and completed task logs.
   - Direct access to `.system_generated/` or `getStateDir()` is denied; use `agy-context transcript` when permitted by the parent's access policy.
3. **Layer 3 (Synchronous window)**:
   - Non-daemon `run_command` calls without an explicit `WaitMsBeforeAsync` default to 10,000ms.
