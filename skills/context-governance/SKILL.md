---
name: context-governance
description: >-
  Use when running shell commands with large outputs, inspecting session transcript health
  via agy-context, preventing repetitive background polling loops, or inspecting codebases with RTK.
---

# Context Governance & Execution Guard (Agy-Context-Saver + RTK)

`Agy-Context-Saver` and `RTK` compress shell output, enforce bounded workspace file reads, stop background-task busy-polling, and provide CLI commands for conversation transcript inspection and access control.

## Architectural Boundary

- **RTK (`>= 1.1.0`)**: Compresses noisy test, build, lint, container, and `git status`/`push`/`pull`/`fetch` stdout via the Narrow High-ROI Pre-Gate (`AGY_RTK_MODE=pregate|off`, default `pregate`), reads step spillovers and completed task logs (`rtk read`), and remains available explicitly (`rtk <cmd>`, `rtk err`, `rtk summary`). Precision inspection tools (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, workspace `cat`/`head`/`tail`, `ps`, `git diff`/`show`/`log`), pipelines, redirects, and `--json`/`--porcelain` commands stay untouched and lossless.
- **Agy-Context-Saver (`v2.1.2`)**: Exposes the two-tier `agy-context transcript` CLI (`~9.2 KB` inline defaults + `--full`/`--out` `512 KB` deep mode) and lifecycle management commands below. Always-active Layer 1–3 execution guardrails (Reactive Wakeup per-task backoff & conditioned stall watchdogs, unblocked native workspace discovery, unified `300L / 24 KiB` `read_file` bounds, `<= 150` lines on spillover/completed task-log reads, `10s` sync window, and `AGY_DISABLE_BENCHMARK_GUARD=1`) are injected via `rules/AGENTS.md`.

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
Exports a sanitized conversation transcript summary (`--sanitized` is required to redact tool payload bodies and secrets for safe sharing or restricted child review), keeping stdout within ~`9.2 KB` inline unless `--full` or `--out`/`--output <path>` unlocks the `512 KB` deep tier (`--max-chars` overrides up to `524,288` bytes).
```bash
agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--full] [--max-chars N] [--out|--output <path>] [--file <path>] [--json]
```

### 7. `agy-context transcript access` (alias: `policy`)
Controls parent transcript access policies for child subagents and `/swarm` workers.
```bash
agy-context transcript access [status|off|on|reset|self-only] [--status | --off (--deny-children) | --on (--reset) | --self-only | --mode <open|allowlist|self-only|deny> | --allow <id,@roster*...> | --deny <id,@roster*...> | --ttl <sec>] [--json]
```
- **First-line launch directives**: Place `[agy-transcript-access: deny]`, `[agy-transcript-access: self-only]`, or `[agy-transcript-access: allow]` on the first non-empty line of a `define_subagent` `SystemPrompt`, `invoke_subagent` `Prompt`, or `/swarm` worker `brief` (later lines and code blocks are ignored).
- **5-tier precedence**: `1. Policy Owner` -> `2. Explicit CLI --deny` -> `3. Explicit CLI --allow` (supports `@roster*` prefix globs such as `@reviewer-*`) -> `4. First-Line Launch Directive` -> `5. Cohort Default Mode`.
- **Stale-lock protection & immutable Tier 4 disclosure**: Parent CLI policies (`policies[ownerId]`) expire after a 1-hour default TTL (`--on`/`--reset` clears only parent overrides while immutable Tier 4 `deny`/`self-only` launch directives remain enforced), Step 0 `USER_INPUT` top-level user sessions bypass child locks automatically, Step 0/1 `sender=<parentConvId>` binds child agents to their parent policy, and both `agy-context transcript access --status` and `agy-context status` disclose active `launchRestrictions` alongside the parent CLI policy.

### 8. `agy-context status`, `setup`, `uninstall` & `restore-backups`
Audits, synchronizes, removes, or restores backups for the plugin link, single global `PreToolUse` hook, CLI shims, RTK (`>= 1.1.0`), and `Transcript Access Policy` (run `uninstall` or `restore-backups` only when explicitly requested by the user; reload Antigravity Desktop IDE or start a new session after `setup` or `uninstall` so hook registrations update cleanly).
```bash
agy-context status [--json]
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
agy-context restore-backups
```
