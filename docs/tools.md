# CLI & Hook Reference

`Agy-Context-Saver` (`v2.1.2`) provides the `agy-context` CLI (`bin/agy-context.mjs`, installed to `~/.gemini/antigravity/bin/agy-context`) and the single global `agy-context-saver` `PreToolUse` hook (`scripts/execution-guard-hook.mjs` routing dynamically to `scripts/hook/{file,shell,task}-guard.mjs`), paired with **RTK (`>= 1.1.0`)** via the Narrow High-ROI Pre-Gate (`AGY_RTK_MODE=pregate|off`, default `pregate`).

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

---

## Workspace File Bounds & Output Inspection

Native `grep_search`, `find_by_name`, and `list_dir` run directly on workspace paths (while staying blocked on `.system_generated/` and `getStateDir()`). `read_file` and output inspection guardrails:

| Target | Enforced Guardrail |
| :--- | :--- |
| **Workspace files ($\le 800\text{L}$ & $\le 45\text{ KiB}$) & media** | Files $\le 800$ lines and $\le 45\text{ KiB}$, safe multimodal media (`.png`, `.jpg`, `.webp`, `.pdf`, audio/video), and Antigravity special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, own non-symlink `.system_generated/swarm/plan.json`, `swarm_view/`, `.gemini/config/`) need no line bounds. |
| **Large workspace files ($> 800\text{L}$ or $> 45\text{ KiB}$)** | Omitted bounds are denied; pass explicit `StartLine` and/or `EndLine` ($\le 800$ lines, EOF-clamped via $1\text{ MiB}$ newline scan, single-bound supported) to `read_file` / `view_file` (batch parallel $\le 800\text{L}$ slices in one turn when full coverage is needed). `read_many_files` and `ByteOffset`-only reads are denied. |
| **Spillovers & completed task logs** | Both `.system_generated/steps/<step>/output.txt` spillovers and `COMPLETED` `tasks/<taskId>.log` files allow bounded `read_file` ($\le 150\text{L}$) or single unchained `rtk read <path>` (`cat` and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`; `--head-lines 150` / `--tail-lines 150` required above `45 KiB`; `RUNNING` task logs are always denied). |

---

## 1. `agy-context transcript health`

- **Aliases:** `stats`, `info`
- **Usage:** `agy-context transcript health [<id[,id...]>] [--id <uuid[,uuid...]>] [--parent <uuid|current>] [--file <path>] [--json]`

Streams `transcript.jsonl` to report step counts, user turns, tool call counts, transcript byte size, per-task and direct-subagent backoff-aware busy-polling events (`>= 30s` per task and `>= 180s` per conditioned direct subagent stall watchdog, while flagging `/swarm` one-shot polls and unconditioned loops), and local RTK status. Passing multiple `--id` values (comma-separated, repeatable, or positional) or `--parent <uuid|current>` emits a combined cohort health table (or structured `sessions[]` + `totals` JSON) in a single call.

| Flag / Argument | Value | Required | Description |
| :--- | :---: | :---: | :--- |
| `[<id[,id...]>]` / `--id` | `<uuid[,uuid...]>` | No* | One or more conversation UUIDs (positional, comma-separated, or repeatable `--id`). (*Inside Antigravity sessions, `PreToolUse` auto-injects `--id <callerConvId>` in both `open` and `self-only` modes when omitted or `current`; required only in direct external CLI shells when `>= 2` sessions ran in the last 5 minutes without `GEMINI_CONVERSATION_ID`. Multi-session `--id` is disabled in `self-only` mode.) |
| `--parent` | `<uuid \| current>` | No | Audit health across all child sessions belonging to `<uuid>` in one call (disabled in `self-only` mode). |
| `--file` | `<path>` | No | Explicit path to `transcript.jsonl` inside Antigravity's brain roots (`antigravity`, `antigravity-cli`, `antigravity-ide`; disabled under `self-only` mode outside caller's session). |
| `--json` | `(none)` | No | Output JSON instead of Markdown. |

```bash
agy-context transcript health
agy-context transcript stats 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc
agy-context transcript info --parent 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --json
agy-context transcript health --id <uuid1>,<uuid2> --json
```

| Status | Condition | Action |
| :--- | :--- | :--- |
| **`HEALTHY`** | Polling $= 0$, User turns $\le 40$ (advisory reminder from $35\text{--}40$ turns) | Proceed normally (summarize and start a fresh conversation when turns reach $35+$). |
| **`WARNING`** | User turns $> 40$ or $1\text{--}3$ polling violations | Stop polling violations immediately and/or summarize progress in a fresh conversation. |
| **`CRITICAL`** | Busy-polling events $> 3$ | Stop polling `manage_task(Action='status')` and wait for Reactive Wakeup (`<SYSTEM_MESSAGE>`). |

---

## 2. `agy-context transcript read`

- **Usage:** `agy-context transcript read [<id>] [options]`

Streams conversation turns from `transcript.jsonl` (or `transcript_full.jsonl`) into Markdown, or delegates to a 1-line-per-step session outline via `query --summary --include-tools` when `--outline` or `--summary` is passed (`outline` / `summary` aliases route directly to `query --summary --include-tools`). Markdown and JSON defaults stay within a `9,200`-byte inline ceiling so standard tool calls avoid `run_command` output spillover while stripping `Created At:` metadata noise, middle-eliding long file paths, and printing continuation `--offset`/`--limit` hints.

| Flag / Argument | Value | Default | Description |
| :--- | :---: | :---: | :--- |
| `[<id>]` / `--id` | `<uuid>` | Active / auto | Conversation UUID (positional or `--id`). |
| `--mode` | `compact \| full` | `compact` | Read `transcript.jsonl` (`compact`) or `transcript_full.jsonl` (`full`). |
| `--last-turns` | `<N>` | `3` | Number of recent turns (`0` returns trailing bounded window up to 200 steps; promptless `/swarm` workers with zero user messages anchor on substantive wakeup `SYSTEM_MESSAGE` steps; aliases: `--last`, `--tail`). |
| `--offset` / `--limit` | `<N>` | `(none)` | 0-indexed forward step ordinal offset (starts at `0` when `--limit` is passed alone) and maximum steps per page (`50` default, hard-capped at `200` for `read`; `500` default / `2000` with `--full`/`--out` in `--outline` mode). |
| `--outline` / `--summary` | `(none)` | `false` | Delegate to `query --summary --include-tools` to print a 1-line-per-step outline (ignores `--mode`, `--last-turns`, `--offset`); with `--json`, emits compact `{ step_index, type, role, created_at, status, summary }` items. |
| `--start` / `--end` | `<N>` | `0` / `999999` | Step index bounds in `--outline` / `--summary` mode. |
| `--full-args` | `(none)` | `false` | Show untruncated tool argument previews in `--outline` mode. |
| `--include-thinking` | `(none)` | `false` | Include model thinking blocks. |
| `--full` | `(none)` | `false` | Opt into the deep `512 KB` rendering tier, bypassing inline line/arg clamps (`1,000c` lines, `4,000c` thinking, `240c` large bodies). |
| `--max-chars` | `<N>` | `(tier default)` | Override the serialized UTF-8 output budget (up to `524,288` bytes). With `--out`, the budget applies to the artifact. |
| `--out` / `--output` | `<path>` | `(none)` | Write deep output (up to `512 KB`, including bounded `--json` artifacts with `jsonTruncated` metadata) to a safe `.md`/`.json`/`.txt` artifact outside protected directories and print a compact summary to stdout. |
| `--file` / `--json` | `<path>` / `(none)` | `(none)` | Explicit `.jsonl` file path or JSON output. |

```bash
agy-context transcript read 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --last-turns 2
agy-context transcript read 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --outline --limit 50
agy-context transcript read 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --mode full --full --out ./session.md
```

---

### Output budgets

`read`, `outline`, `query`, `tools`, and `export --sanitized` default to 9,200 UTF-8 bytes. `step` defaults to 24,000 bytes. The deep tier (`--full`, `--out`) allows up to 524,288 bytes. An explicit `--max-chars` budget includes serialization and the trailing newline. With `--out`, stdout reports the write and the limit applies to the file.

`--out` accepts any safe workspace-relative `.md`, `.json`, or `.txt` path outside protected state, governance, and benchmark directories. If you write artifacts under a `scratch/` folder, add `scratch/` to `.gitignore` or `.git/info/exclude` so exports stay untracked. (In `self-only` child mode, `--out` is scoped to `<workspace>/scratch/` or `<brainDir>/<convId>/scratch/`.)

Bounded JSON stays parseable (using 2-space indentation whenever the serialized page or clamped subset fits inside the budget before falling back to compact single-line JSON). When serialization omits records or raw fields, `jsonTruncated` and the included/total counts describe the reduction (`jsonSessionsIncluded` / `jsonSessionsTotal` and `jsonRowsIncluded` / `jsonRowsTotal` for `export --json`). `nextCursor` describes the serialized page (`export` drops truncated rows/sessions rather than splitting inside individual cells, omitting `nextCursor` when multiple sessions trim rows on the same page). If an individual record is too large for a JSON page, use a larger budget or inspect the step in Markdown with a field or line slice. A budget that cannot fit the required metadata returns a nonzero exit code and a diagnostic. Existing output files are preserved on that error.

## 3. `agy-context transcript query`

- **Aliases:** `grep`, `search`, `find`, `tools`, `outline`, `summary`
- **Usage:** `agy-context transcript query [<pattern>] [<id>] [options]` | `agy-context transcript outline [<id>] [options]`

Searches conversation transcripts by regex or substring, hydrating truncated fields from `transcript_full.jsonl` automatically in `auto` mode. Default inline queries stay within a `9,200`-byte ceiling in Markdown and JSON (with `date=YYYY-MM-DD UTC` header compaction, collapsed duplicate tool tags `(xN)`, order-independent boilerplate stripping with `[spill: steps/<N>]` surfacing, and `nextCursor` hints); `--full`, `--max-chars`, or `--out` opts into the deep `512 KB` tier.

- `grep`, `search`, `find`: enable `--include-tools` by default so matches inside tool names and arguments are returned.
- `tools`: defaults to `--roles assistant --field tool_args --include-tools --start 0 --end 999999 --limit 500` (widened to `2000` with `--full` or `--out`) to list tool calls and arguments across a step range.
- `outline`, `summary`: map to `query --summary --include-tools --start 0 --end 999999 --limit 500` (`2000` with `--full` or `--out`, accepting `[<id>]` as the positional conversation ID).

| Flag / Argument | Value | Default | Description |
| :--- | :---: | :---: | :--- |
| `<pattern>` / `--query` | `<regex>` | `""` | Case-insensitive regex or substring pattern (first positional arg or `--query`). |
| `[<id>]` / `--id` | `<uuid>` | Active / auto | Conversation UUID (second positional arg or `--id`). |
| `--roles` | `<csv>` | `all` | Comma-separated filter: `user`, `assistant`, `subagent`, `tool`, `system`, `generic`, `error`, or `all`. |
| `--mode` | `auto \| compact \| full` | `auto` | `auto` scans `transcript.jsonl` and hydrates `truncated_fields` from `transcript_full.jsonl` when matched. |
| `--start` / `--end` | `<N>` | `(none)` | Inclusive `step_index` bounds. |
| `--last-turns` | `<N>` | `(none)` | Restrict search to the last `N` turns (aliases: `--last`, `--tail`). |
| `--limit` | `<N>` | `5` (`100` w/ `--summary`, `500` w/ `--full` or explicit range/`tools`, `2000` on `outline`/`tools` w/ `--full`/`--out`) | Maximum matching steps to return. |
| `--summary` / `--outline` | `(none)` | `false` | Print compact 1-line timeline bullets with `[ERROR]`, `[spill: steps/<N>]`, and `[tools: ...]` tags (or compact `{ step_index, type, role, created_at, status, summary }` items with `--json`); `--full` unlocks the `512 KB` / `500`-step budget while keeping individual bullets compact unless `--full-args` is passed. |
| `--include-tools` | `(none)` | `false` (`true` on `grep`/`search`/`find`/`tools`) | Search and display tool call names and arguments. |
| `--full-args` | `(none)` | `false` | Print full tool call arguments (unclamping `LARGE_BODY_ARG_KEYS` when combined with `--full`). |
| `--field` | `<spec>` | `all` (`tool_args` on `tools`) | Project a single field: `content`, `thinking`, `tool_calls`, `tool_args`, `tool_args:<Key>`, or `all`. |
| `--include-thinking` | `(none)` | `false` | Search and include thinking blocks. |
| `--full` | `(none)` | `false` | Opt into deep `512 KB` ceiling and `500`-step default cap (keeping `--summary` lines compact and `LARGE_BODY_ARG_KEYS` summarized unless `--full-args` is passed). |
| `--max-chars` | `<N>` | `(tier default)` | Override the serialized UTF-8 output budget (up to `524,288` bytes). With `--out`, the budget applies to the artifact. |
| `--out` / `--output` | `<path>` | `(none)` | Write deep results (up to `512 KB`, including bounded `--json` artifacts with `jsonTruncated` metadata) to a safe `.md`/`.json`/`.txt` artifact outside protected directories and print a compact summary to stdout. |
| `--json` / `--file` | `(none)` / `<path>` | `(none)` | Output JSON or read an explicit `.jsonl` file path. |

```bash
agy-context transcript grep "verification failed" 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --limit 5
agy-context transcript tools "run_command" --field tool_args:CommandLine --full-args
agy-context transcript outline 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --limit 50
agy-context transcript query --id 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --summary --limit 10
agy-context transcript outline 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --full --out ./outline.md
```

---

## 4. `agy-context transcript step`

**Usage:** `agy-context transcript step [<N|N,M|N-M|N..M>] [<id>] [options]`

Extracts untruncated fields from `transcript_full.jsonl` (falling back to normalized `transcript.jsonl` records when needed) for a single step, a comma-separated list of steps, or a step range, with optional line slicing across every `--field` mode. Rendered Markdown and JSON outputs normalize `\r\n`/`\r` line endings and collapse excess blank lines, trim `<thinking>` trailing newlines before `>` quoting, strip leading duplicate `Created At:`/`Completed At:` headers on non-dialogue steps (including immediately after hook-rewrite or spillover truncation notices while preserving those notices, exit-code lines, and spillover URLs), pretty-print bounded (`<= 64 KB`) single-line JSON outputs in Markdown content renders (including `--field content` and `--full`), and decode compact `transcript.jsonl` `tool_calls[].args` encodings (gated strictly on compact-sourced steps). JSON output (`--json`) is deduplicated: `--field all` emits `step` (`steps[].step` in batch mode), while projected fields emit only `data` (`steps[].data` in batch mode) without repeating raw steps or a duplicate top-level `data` array.

| Flag / Argument | Value | Default | Description |
| :--- | :---: | :---: | :--- |
| `<steps>` / `--step` | `<N\|N,M\|N-M\|N..M>` | Required* | Step index, comma list (`10,12,15`), hyphen range (`10-15`), or dot range (`10..15`). (*Or pass `--start <N> --end <M>`.) |
| `[<id>]` / `--id` | `<uuid>` | Active / auto | Conversation UUID (second positional arg or `--id`). |
| `--start` / `--end` | `<N>` | `(none)` | Inclusive step range bounds when `--step` is omitted. |
| `--field` | `<spec>` | `all` | Target field: `content`, `thinking`, `tool_calls`, `tool_args`, `tool_args:<Key>`, or `all`. |
| `--head` / `--tail` | `<N>` | `(none)` | Return only the first or last `N` lines across any rendered `--field` text output (aliases: `--head-lines`, `--tail-lines`). |
| `--line-start` / `--line-end` | `<N>` | `(none)` | 1-indexed inclusive line slice across any rendered `--field` text output (single-line payloads wrap into 120-char slices when line-slicing). |
| `--full` | `(none)` | `false` | Opt into the deep `512 KB` ceiling, bypassing `4,000c` thinking, `1,000c` line, and `240c` large-body argument clamps (`24 KB` safety ceiling applies when `--full`/`--out`/`--max-chars` are omitted). |
| `--max-chars` | `<N>` | `(tier default)` | Override the serialized UTF-8 output budget (up to `524,288` bytes). With `--out`, the budget applies to the artifact. |
| `--out` / `--output` | `<path>` | `(none)` | Write deep single/batch step output (up to `512 KB`, including bounded `--json` artifacts with `jsonTruncated` metadata) to a safe `.md`/`.json`/`.txt` artifact outside protected directories and print a compact summary to stdout. |
| `--file` / `--json` | `<path>` / `(none)` | `(none)` | Explicit `.jsonl` file path or JSON output. |

```bash
agy-context transcript step 1139 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --field content
agy-context transcript step 110..115 --field tool_args:CommandLine --tail 40
agy-context transcript step 566 --field tool_args:CommandLine --line-start 1 --line-end 40
agy-context transcript step --step 42 --full --out ./step-42.md
```

---

## 5. `agy-context transcript list`

- **Alias:** `ls`
- **Usage:** `agy-context transcript list [--limit <N>] [--parent <id>] [--lineage] [--json]`

Lists recent conversation directories across Antigravity brain roots (`~/.gemini/antigravity/brain`, `~/.gemini/antigravity-cli/brain`, `~/.gemini/antigravity-ide/brain`) containing a `.system_generated/logs/transcript.jsonl` (or `transcript_full.jsonl`) file, sorted newest-first by modification time (`mtime`). Pass `--lineage` to display `sessionKind`, `stepCount`, `parentConvId`, and `@rosterName`, or `--parent <id>` to filter strictly to children of a parent session. Disabled when the caller is restricted by a `self-only` or `deny` parent access policy.

```bash
agy-context transcript ls --limit 5
agy-context transcript list --parent 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --lineage --json
```

---

## 6. `agy-context transcript export`

- **Alias:** `dump`
- **Usage:** `agy-context transcript export [<id>] [--id <conv[,conv...]>] [--parent <id>] --sanitized [--start N] [--end N] [--limit N] [--full] [--max-chars N] [--out|--output <path>] [--file <path>] [--json]`

Generates a transcript-isolated sanitized Markdown (or `--json`) summary index of executed steps and compact tool calls, omitting raw `.system_generated/` JSONL lines, `thinking` blocks, and large file bodies while redacting embedded media/base64 payloads and token strings. `--sanitized` is required; raw transcript export is prohibited. Standard stdout exports obey the `9,200`-byte inline ceiling, while `--full` or `--out` opts into the `524,288`-byte (`512 KB`) deep tier (`--max-chars` sets any custom ceiling up to `524,288` bytes, sizing Markdown and JSON independently in UTF-8 bytes and failing nonzero without overwriting existing files if metadata cannot fit).

| Flag / Argument | Value | Default | Description |
| :--- | :---: | :---: | :--- |
| `[<id>]` / `--id` | `<uuid[,uuid...]>` | Active / auto | One or more conversation UUIDs (positional, comma-separated, or repeatable `--id`). |
| `--parent` | `<uuid \| current>` | `(none)` | Export sanitized summary tables for all child sessions belonging to `<uuid>`. |
| `--sanitized` | `(none)` | Required | Explicit sanitization opt-in required on all `transcript export` calls. |
| `--start` / `--end` | `<N>` | `(none)` | Inclusive `step_index` range filter. |
| `--limit` | `<N>` | `150` (max `500`) | Maximum steps retained per exported session. |
| `--full` | `(none)` | `false` | Opt into the deep `524,288`-byte (`512 KB`) stdout rendering tier. |
| `--max-chars` | `<N>` | `(tier default)` | Override the serialized UTF-8 byte ceiling (up to `524,288` bytes). With `--out`, applies to the written artifact. |
| `--out` / `--output` | `<path>` | `(stdout)` | Safely write index to a workspace-relative `.md`, `.json`, or `.txt` path (for example `./transcript-index.md`, up to `524,288` bytes), rejecting `..`, symlinks, and protected state/config paths. Add `scratch/` to `.gitignore` or `.git/info/exclude` if you store exports there. |
| `--file` / `--json` | `<path>` / `(none)` | `(none)` | Explicit single-session `.jsonl` path or bounded JSON output (`jsonSessionsIncluded`/`Total`, `jsonRowsIncluded`/`Total`, `jsonTruncated`, `nextCursor`). |

```bash
agy-context transcript export --parent 68cbb7bc-ce63-4be7-accb-b0e3d37f8ecc --sanitized --out ./transcript-index.md
```

---

## 7. `agy-context transcript access`

- **Alias:** `policy`
- **Usage:** `agy-context transcript access [status|off|on|reset|self-only] [options]`

Manages parent transcript access policies for child subagents (`define_subagent`, `invoke_subagent`) and `/swarm` workers.

| Flag / Shorthand | Value | Default | Description |
| :--- | :---: | :---: | :--- |
| `--status` / `status` | `(none)` | Default if no flags | Show active policy mode, owner session ID, allow/deny lists, remaining TTL, and recent `launchRestrictions`. |
| `--off` / `--deny-children` / `off` | `(none)` | `false` | Set cohort default mode to `deny` for all child sessions. |
| `--on` / `--reset` / `on` / `reset` | `(none)` | `false` | Clear the caller's parent CLI policy (`policies[ownerId]`) and restore `open` cohort default; child Tier 4 launch directives stay enforced and visible under `launchRestrictions`. |
| `--self-only` / `self-only` | `(none)` | `false` | Restrict children to their own `--id <callerConvId>` transcript (`list`/`ls` and `--file` blocked). |
| `--mode` | `open \| allowlist \| self-only \| deny` | `open` | Set explicit cohort default mode. |
| `--allow` | `<id,@roster*...>` | `(none)` | Comma-separated allowed conversation IDs or `@roster*` prefix globs (switches `open` to `allowlist`). |
| `--deny` | `<id,@roster*...>` | `(none)` | Comma-separated denied conversation IDs or `@roster*` prefix globs. |
| `--ttl` | `<sec>` | `3600` (1h) | Policy expiration time in seconds (must be a positive integer). |
| `--json` | `(none)` | `false` | Output JSON. |

See [Lifecycle Governance](governance.md#parent-transcript-access-control) for first-line launch directives (`[agy-transcript-access: deny|self-only|allow]`) and the 5-tier precedence rules.

---

## 8. `agy-context status`, `setup`, `uninstall` & `restore-backups`

Audits, synchronizes, removes, or restores validated non-clobbering backups for the plugin link, single global `PreToolUse` hook, CLI shims, RTK configuration, and stale MCP entries (reload Antigravity Desktop IDE or start a new session after `setup` or `uninstall` so hook registrations activate or clear from memory cleanly):

```bash
agy-context status [--json]
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
agy-context restore-backups
```

Sample `agy-context status` output:

```text
Checking Agy-Context-Saver installation status...
- Native Plugin Link: ACTIVE (~/.gemini/config/plugins/agy-context-saver)
- Execution Governor Hook (agy-context-saver): ACTIVE (global hooks.json)
- CLI Shim (agy-context): INSTALLED (~/.gemini/antigravity/bin)
- RTK Command Optimizer (>= 1.1.0): INSTALLED (rtk 1.1.0)
- MCP Cleanup: CLEAN (0 duplicate MCP configs/schemas)
- Plugin Enabled (config.json): ENABLED
- Transcript Access Policy: OPEN (default)   # or OPEN (parent CLI policy) | Recent launch-restricted children: ... when Tier 4 child locks are active
Overall Status: HEALTHY & ACTIVE
```
