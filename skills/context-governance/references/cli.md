# `agy-context` CLI Reference

Run `agy-context` via `run_command` (`~/.gemini/antigravity/bin/agy-context`). Invoke `agy-context transcript ...` without `&&`, `||`, `;`, write redirects, or subshells; safe stdin-only read-only filter pipes (`| rg`, `| grep`, `| head`, `| tail`, `| jq`, `| wc`, `| cut`, `| sort`, `| uniq`, `| tr`, plus `2>/dev/null`) are allowed to stay under Antigravity's `~10 KB` (`9,892 B`) `run_command` spillover ceiling. For unfiltered `--full` dumps `> 9.2 KB`, pass `--out <path>` (prints `lineCount` and `bytesWritten`) and read directly with parallel `<= 800L` `read_file` slices (`45 KiB` each).

## 1. `agy-context transcript health` (aliases: `stats`, `info`)
Checks turn counts, step counts, raw transcript size, RTK status, and busy-polling events for a single session, comma-separated/repeatable `--id` list, or an entire parent cohort via `--parent <uuid|current>`.
```bash
agy-context transcript health [<id[,id...]>] [--id <conv[,conv...]>] [--parent <uuid|current>] [--json] [--file <path>]
```

## 2. `agy-context transcript read`
Streams recent conversation turns in Markdown (default ~`9.2 KB` inline ceiling with `nextCursor` hints), delegates to `query --summary --include-tools` when `--outline` is passed, or opts into the `512 KB` deep tier via `--full`/`--out`.
```bash
agy-context transcript read [<id>] [--id <conv>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--outline] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

## 3. `agy-context transcript query` (aliases: `grep`, `search`, `find`, `tools`, `outline`, `summary`)
Searches conversation transcripts by regex or substring with automatic dereferencing of truncated fields, role filtering (`user`, `assistant`, `subagent`, `tool`, `generic`, `system`, `error`, `all`), and `--full-args` / `--field` projection. Default inline outputs stay within ~`9.2 KB` (with `--summary` defaulting to `100` steps, `date=YYYY-MM-DD UTC` header compaction, duplicate tool collapse `(xN)`, boilerplate stripping with `[spill: steps/<N>]`, and compact `{ step_index, type, role, created_at, status, summary }` items on `--summary`/`outline --json`); `--full`, `--max-chars`, or `--out` opts into `512 KB` and raises the default step cap to `500` (keeping `--summary`/`outline` lines compact and `LARGE_BODY_ARG_KEYS` summarized unless `--full-args` is also passed). The `tools` alias defaults to `--roles assistant --field tool_args --include-tools`, and `outline` / `summary` map to `query --summary --include-tools`.
- **Recommended batched forensic workflow**:
  1. **Cohort discovery & metrics**: `agy-context transcript list --parent <uuid> --lineage` and `agy-context transcript health --parent <uuid> --json` (or `--id <u1,u2,...> --json`)
  2. **Batched `--full` audit (one parallel turn across sessions)**: `agy-context transcript outline --id <conv> --full | rg "DENIED|ERROR"` (or `| tail -n 80`, keeping stdout `< 10 KB` with zero spillover) or `--full --out <path>` for unfiltered `> 9.2 KB` dumps (prints exact `lineCount` + `bytesWritten` for immediate parallel `<= 800L` `read_file` slices)
  3. **Targeted step extraction (only when specific truncated outputs remain)**: `agy-context transcript step <N,M,K|N..M> --id <conv> --field content --full` (batch-extract specific step outputs without 1-by-1 `--step <N>` loops)
```bash
agy-context transcript query [<pattern>] [<id>] [--id <conv>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

## 4. `agy-context transcript step`
Extracts untruncated content or specific fields (`content`, `thinking`, `tool_calls`, `tool_args`, `tool_args:<Key>`, `all`) for one step or a batch/range of steps (`2,8,14`, `2-10`, `2..10`, or `--start 2 --end 10`) from `transcript_full.jsonl`, with optional `--head <N>`, `--tail <N>`, `--line-start <N>`..`--line-end <N>`, `--max-chars <N>`, `--out <path>`, and `--full` (`512 KB` unclamped mode). JSON output (`--json`) is deduplicated: `--field all` emits `step` (`steps[].step` in batch mode), while projected fields (`content`, `thinking`, `tool_calls`, `tool_args*`) emit only `data` (`steps[].data` in batch mode) without duplicating raw steps.
```bash
agy-context transcript step [<N|N,M|N-M|N..M>] [<id>] [--id <conv>] (--step <N|N,M|N-M|N..M> | --start N --end M) [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--head N] [--tail N] [--line-start N] [--line-end N] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

## 5. `agy-context transcript list` (alias: `ls`)
Lists recent conversations across Antigravity's brain roots (`~/.gemini/antigravity/brain`, `~/.gemini/antigravity-cli/brain`, `~/.gemini/antigravity-ide/brain`) sorted by modification time, with optional `--parent <uuid>` filtering and `--lineage` metadata.
```bash
agy-context transcript list [--limit N] [--parent <uuid>] [--lineage] [--json]
```

## 6. `agy-context transcript export` (alias: `dump`)
Exports a sanitized conversation transcript summary (`--sanitized` is required to redact tool payload bodies and secrets for safe sharing or restricted child review), keeping stdout within ~`9.2 KB` inline unless `--full` or `--out`/`--output <path>` unlocks the `512 KB` deep tier (`--max-chars` overrides up to `524,288` bytes).
```bash
agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--full] [--max-chars N] [--out|--output <path>] [--file <path>] [--json]
```

## 7. `agy-context transcript access` (alias: `policy`)
Controls parent transcript access policies for child subagents and `/swarm` workers.
```bash
agy-context transcript access [status|off|on|reset|self-only] [--status | --off (--deny-children) | --on (--reset) | --self-only | --mode <open|allowlist|self-only|deny> | --allow <id,@roster*...> | --deny <id,@roster*...> | --ttl <sec>] [--json]
```
- **First-line launch directives**: Place `[agy-transcript-access: deny]`, `[agy-transcript-access: self-only]`, or `[agy-transcript-access: allow]` on the first non-empty line of a `define_subagent` `SystemPrompt`, `invoke_subagent` `Prompt`, or `/swarm` worker `brief` (later lines and code blocks are ignored).
- **5-tier precedence**: `1. Policy Owner` -> `2. Explicit CLI --deny` -> `3. Explicit CLI --allow` (supports `@roster*` prefix globs such as `@reviewer-*`) -> `4. First-Line Launch Directive` -> `5. Cohort Default Mode`.
- **Stale-lock protection & immutable Tier 4 disclosure**: Parent CLI policies (`policies[ownerId]`) expire after a 1-hour default TTL (`--on`/`--reset` clears only parent overrides while immutable Tier 4 `deny`/`self-only` launch directives remain enforced), Step 0 `USER_INPUT` top-level user sessions bypass child locks automatically, Step 0/1 `sender=<parentConvId>` binds child agents to their parent policy, and both `agy-context transcript access --status` and `agy-context status` disclose active `launchRestrictions` alongside the parent CLI policy. Restricted children must not retry blocked transcript commands (5 denials trip `force_ask`).

## 8. `agy-context status`, `setup`, `uninstall` & `restore-backups`
Audits, synchronizes, removes, or restores backups for the plugin link, single global `PreToolUse` hook, CLI shims, RTK (`>= 1.1.0`), and `Transcript Access Policy` (run `uninstall` or `restore-backups` only when explicitly requested by the user; reload Antigravity Desktop IDE or start a new session after `setup` or `uninstall` so hook registrations update cleanly).
```bash
agy-context status [--json]
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
agy-context restore-backups
```
