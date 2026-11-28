# Transcript CLI vs. Native Antigravity

Google Antigravity stores conversation history as raw JSON Lines files (`.system_generated/logs/transcript.jsonl` and `transcript_full.jsonl`) inside separate session folders for Antigravity Desktop, the `agy` CLI, and Antigravity IDE, without shipping a dedicated transcript tool. Inspecting those logs natively means locating a known session ID on disk, grepping `invoke_subagent` calls to trace child runs, and cross-referencing cut-off outputs between the compact and full log files by hand.

`agy-context transcript` (`v2.2.2`) adds a structured, local-first CLI and `PreToolUse` governance layer on top of those same log files. It handles cross-session discovery, bounded Markdown and JSON summaries, single-pass full-step retrieval, session and team health checks, redacted exports, and parent-controlled child access with zero MCP tool schema overhead.

![Native Antigravity logs compared to the agy-context Transcript CLI](assets/transcript-cli-vs-native.svg)

---

## Side-by-Side Comparison

| Capability | Native Antigravity Logs | `agy-context transcript` CLI |
| :--- | :--- | :--- |
| **Session discovery and lineage** | Requires knowing the target session ID and checking Antigravity's session folders (`~/.gemini/antigravity/brain`, `antigravity-cli/brain`, `antigravity-ide/brain`); tracing child agents requires grepping `invoke_subagent` in `transcript.jsonl`. | `list --lineage` scans all three session folders sorted newest-first, labels `top-level` vs. `swarm` runs, resolves `parentConvId` and `@rosterName`, and filters full child teams with `--parent <uuid>`. |
| **Output size and spillover control** | Raw `transcript.jsonl` files routinely grow to several megabytes; direct reads risk hitting `read_file` caps or overflowing `run_command` past its ~10 KB stdout spillover threshold. | `read`, `outline`, `query`, `tools`, and `export --sanitized` clamp inline output to `9,200` UTF-8 bytes in Markdown and JSON (`step` defaults to `24,000` bytes), strip repeated metadata, emit continuation cursors, and switch to read-only pipes, `--full`, or `--out <path>` (up to `512 KB`) when full output is needed. |
| **Retrieving cut-off steps** | Agents inspect `transcript.jsonl`, spot `truncated_fields`, and manually open the matching entry in `transcript_full.jsonl` (where `step_index` can differ from line numbers after `/compact` or session forks). | `query` (`auto` mode) fetches matched cut-off steps from `transcript_full.jsonl` in one streaming pass; `step <N,M|N..M>` extracts batches or ranges directly with `--field` selection and `--head` / `--tail` / `--line-start` / `--line-end` slicing. |
| **Session and cohort health** | No built-in check for turn volume, log size, corrupt JSONL lines, RTK setup, or background-task polling loops. | `health` reports turns, tool calls, byte size, corrupt lines, RTK version, and polling warnings for one session, a comma-separated `--id` list, or an entire `--parent` worker team in one call. |
| **Access control and redaction** | Any session or child worker can read raw session logs directly from disk; no built-in redaction for sharing traces. | `PreToolUse` blocks direct `.system_generated/` reads, enforces a 5-tier parent-to-child policy (`access` CLI + first-line launch directives) backed by 10-second single-use capability grants, and `export --sanitized` omits `thinking` blocks, raw JSONL lines, and secrets. |
| **Prompt and hook integration** | Manual file paths and shell commands; no automatic conversation binding. | Zero MCP schema overhead on idle turns; inside Antigravity sessions, `PreToolUse` auto-injects `--id <callerConvId>` when omitted or `current` and permits safe stdin-only filter pipes. |

---

## Core Differences in Practice

### 1. Cross-session discovery and multi-agent lineage (`list`)

Antigravity stores transcripts across separate brain roots depending on whether a session ran in Antigravity Desktop (`~/.gemini/antigravity/brain`), the Antigravity CLI (`~/.gemini/antigravity-cli/brain`), or Antigravity IDE (`~/.gemini/antigravity-ide/brain`). Locating a prior conversation or tracing a 12-worker `/swarm` cohort by hand means checking each directory and grepping for spawned conversation IDs.

`agy-context transcript list` (alias `ls`) scans all available brain roots, sorts sessions by modification time, and adds lineage metadata with `--lineage`:

- `sessionKind`: distinguishes `top-level` user sessions from spawned `swarm` or subagent workers.
- `stepCount`: reports logged steps alongside file size and last-modified timestamp.
- `parentConvId` and `@rosterName`: links each child session back to its coordinator and roster label.
- `--parent <uuid>`: restricts results strictly to the children of a given parent session (up to 50 entries by default instead of 10).

```bash
# Find recent top-level sessions and their spawned workers
agy-context transcript list --lineage --limit 15

# List every worker belonging to one coordinator session as JSON
agy-context transcript ls --parent <parent-uuid> --lineage --json
```

When a parent restricts children to `self-only` or `deny`, `list` is disabled so leaf workers cannot enumerate sibling sessions.

### 2. Output budgets, formatting, and escape hatches (`read`, `outline`, pipes, `--out`)

Raw `transcript.jsonl` records wrap every turn and tool response in verbose JSON objects filled with repeated timestamps, escaped newlines, and large tool payloads. Reading them directly pushes thousands of noisy tokens into the model context or spills stdout into `.system_generated/steps/<step>/output.txt`.

`agy-context transcript` keeps routine inspection inside predictable UTF-8 byte ceilings:

- **Inline tier (`9,200` bytes):** `read`, `outline` / `summary`, `query`, `tools`, and `export --sanitized` stay below Antigravity's `~10 KB` (`9,892 B`) `run_command` spillover ceiling by default. Output renders as Markdown (or valid, parseable `--json` with `jsonTruncated` metadata) with `date=YYYY-MM-DD UTC` header compaction, collapsed duplicate tool tags `(xN)`, middle-elided paths, stripped `Created At:` metadata noise, `[spill: steps/<N>]` markers, and continuation `--offset` / `nextCursor` hints.
- **Step inspection tier (`24,000` bytes):** `step` uses a wider default ceiling so detailed single-step payloads fit cleanly without requiring `--full` on every lookup.
- **Deep tier (`512 KB` via `--full` or `--out`):** Passing `--full`, `--max-chars <N>`, or `--out <path>` raises the ceiling to `524,288` bytes. When writing unfiltered dumps larger than `9.2 KB`, `--out <path>` saves a workspace-relative `.md`, `.json`, or `.txt` file outside protected directories and prints exact `lineCount` and `bytesWritten` counts so you can read it back in parallel `<= 800`-line `read_file` slices.
- **Read-only filter pipes:** `PreToolUse` blocks shell chaining (`&&`, `||`, `;`), write redirects, and subshells on `agy-context transcript`, while allowing stdin-only filter pipes (`| rg`, `| grep`, `| head`, `| tail`, `| jq`, `| wc`, `| cut`, `| sort`, `| uniq`, `| tr`, plus `2>/dev/null`) so deep queries can be narrowed before they reach stdout.

```bash
# Read the most recent turns within the 9.2 KB inline budget
agy-context transcript read <conv-id> --last-turns 4

# Filter a deep session outline without spilling stdout
agy-context transcript outline <conv-id> --full | rg "ERROR|DENIED"

# Write an unfiltered deep outline to disk and report exact lineCount
agy-context transcript outline <conv-id> --full --out ./scratch/outline.md
```

### 3. Searching and retrieving cut-off steps (`query`, `step`)

In native Antigravity logs, `transcript.jsonl` cuts off oversized payloads and marks them in `truncated_fields`, while `transcript_full.jsonl` holds the complete records. Pulling an untruncated tool output natively takes two manual passes and breaks down when line numbers drift from `step_index`.

`query` (aliases: `grep`, `search`, `find`, `tools`, `outline`, `summary`) and `step` handle both files automatically:

- **Single-pass full retrieval (`query --mode auto`):** `query` streams `transcript.jsonl` through a fixed-size ring buffer, tracks matched cut-off step indices, and makes one streaming pass over `transcript_full.jsonl` to pull full records.
- **Role and range filtering:** Narrow matches with `--roles` (`user`, `assistant`, `subagent`, `tool`, `system`, `generic`, `error`, `all`), `--start` / `--end` `step_index` bounds, `--last-turns <N>`, and `--include-tools` / `--include-thinking`.
- **Batch step extraction (`step`):** Pass a single index (`42`), a comma-separated list (`10,12,15`), or a range (`110..115` or `110-115`) to read untruncated data from `transcript_full.jsonl`. Select only the field you need with `--field` (`content`, `thinking`, `tool_calls`, `tool_args`, `tool_args:<Key>`, or `all`) and slice long payloads with `--head`, `--tail`, or `--line-start` / `--line-end`. In `--json` mode, selected fields emit only `data` (`steps[].data` in batch mode) without duplicating full raw step objects.

```bash
# Scan every user prompt across a long session
agy-context transcript query --id <conv-id> --roles user --summary --full

# Pull exact shell commands executed in a session
agy-context transcript tools "run_command" <conv-id> --field tool_args:CommandLine --full-args

# Extract specific full steps or read the top 25 lines of one step
agy-context transcript step 10,42 --id <conv-id> --field content
agy-context transcript step 42 --id <conv-id> --field content --head 25
```

### 4. Single-session and team health checks (`health`)

Native Antigravity logs store raw events without summarizing session health. Checking whether a long conversation is nearing context fatigue or whether one worker out of a dozen fell into a background-task polling loop requires writing a custom parser.

`agy-context transcript health` (aliases: `stats`, `info`) streams one or more transcripts and reports:

- Step count, user turns, model turns, tool call count, total bytes, and corrupt JSONL line count.
- Detected host RTK binary path and version.
- Backoff-aware polling violations across background tasks and direct subagents, rolled up into `HEALTHY`, `WARNING` (more than 40 user turns or 1 to 3 polling violations), or `CRITICAL` (more than 3 polling violations).

Passing `--parent <uuid>` or a comma-separated `--id <u1,u2>` list aggregates an entire multi-agent run into one Markdown table or structured `totals` + `sessions[]` JSON response, making outlier workers visible immediately.

```bash
# Check one session
agy-context transcript health <conv-id> --json

# Audit every child worker in a swarm cohort in one call
agy-context transcript health --parent <parent-uuid> --json
```

### 5. Parent access control and sanitized sharing (`access`, `export --sanitized`)

On disk, native transcript logs are plain files readable by any subagent or `/swarm` worker. That makes it hard to keep isolated leaf workers from reading coordinator prompts or sibling outputs, and raw JSONL files often contain secrets, base64 media blobs, and internal `thinking` traces that should not be copied into review artifacts.

`Agy-Context-Saver` pairs `PreToolUse` with two CLI subcommands to close that gap at the application layer:

- **`access` (alias `policy`) and launch directives:** Parent sessions set cohort defaults (`open`, `allowlist`, `self-only`, `deny`), apply `--allow` / `--deny` rules with conversation UUIDs or `@roster*` prefix globs (such as `@reviewer-*`), or pin individual workers with a first-line `[agy-transcript-access: deny|self-only|allow]` directive in their launch brief. Rules resolve through a strict 5-tier precedence order (`1. Policy Owner`, `2. Explicit CLI --deny`, `3. Explicit CLI --allow`, `4. First-Line Launch Directive`, `5. Cohort Default Mode`). Parent policies expire automatically after a 1-hour default TTL, top-level `USER_INPUT` sessions bypass foreign child locks, and authorized restricted reads are verified via 10-second single-use capability grant files under `<stateDir>/grants/`.
- **`export --sanitized` (alias `dump`):** Produces a Markdown or bounded JSON summary index for one session, a list of IDs, or a `--parent` cohort. The `--sanitized` flag is mandatory: exports omit raw `.system_generated/` JSONL lines, `thinking` blocks, and large file bodies while redacting embedded base64 media and token strings.

```bash
# Restrict workers to their own logs while allowing reviewer roles across the cohort
agy-context transcript access --mode self-only --allow @reviewer-*

# Check active parent rules and any launch-restricted child sessions
agy-context transcript access --status

# Export a redacted summary index for an entire swarm cohort
agy-context transcript export --parent <parent-uuid> --sanitized --out ./scratch/cohort-index.md
```

See [Lifecycle governance](governance.md#parent-transcript-access-control) for the 5-tier precedence diagram and full access control rules.

---

## Common Workflows

Run each `agy-context transcript` command as its own call (or piped to a read-only stdin filter) rather than chaining commands with `&&` or `;`.

### Pick up where a previous session stopped

```bash
# 1. Identify the latest top-level conversation
agy-context transcript list --lineage --limit 10

# 2. Check turn count and size
agy-context transcript health <conv-id> --json

# 3. Read the closing turns and scan earlier user prompts for full context
agy-context transcript read <conv-id> --last-turns 4
agy-context transcript query --id <conv-id> --roles user --summary --full
```

### Audit a multi-agent `/swarm` cohort

```bash
# 1. Enumerate child workers and roster names
agy-context transcript list --parent <parent-uuid> --lineage

# 2. Roll up turns, tool calls, and polling warnings across all children
agy-context transcript health --parent <parent-uuid> --json

# 3. Inspect errors or specific worker steps without overflowing stdout
agy-context transcript outline <worker-id> --full | rg "ERROR|DENIED"
agy-context transcript step 12,18 --id <worker-id> --field content --head 40
```

---

## Operational Notes

- **`step_index` vs. total log entries after compaction or forks:** `health` and `read` report the total number of logged entries in `transcript.jsonl`, whereas `--start` and `--end` filter by `step_index`. After a `/compact` or a forked conversation, `step_index` values can have gaps or start above zero. Use `--offset` and `--limit` to paginate by log ordinal, and check `outline` or `read --last-turns` to confirm active `step_index` bounds before slicing by range.
- **Staying under `run_command` spillover on batched `step` calls:** Because `step` defaults to a `24,000`-byte ceiling rather than `9,200` bytes, combining multiple large steps in one call (such as `step 10,42 --field content`) can exceed Antigravity's `~10 KB` stdout spillover threshold. Pair batched `step` calls with `--head` / `--tail`, `--max-chars 9000`, a read-only pipe (`| head -n 80`), or `--out <path>`.
- **Automatic `--id` binding inside vs. outside Antigravity:** Inside an Antigravity session, `PreToolUse` injects `--id <callerConvId>` automatically whenever `--id` is omitted or set to `current`. In a standalone external terminal (outside `PreToolUse`), pass an explicit conversation UUID whenever two or more sessions were active within the last five minutes and `GEMINI_CONVERSATION_ID` is unset.

---

## Related Documentation

- **[CLI and hook reference](tools.md):** Complete flag tables, defaults, aliases, and JSON output schemas for every `agy-context` subcommand.
- **[Lifecycle governance](governance.md):** `PreToolUse` hook rules, task backoff curves, spillover policies, and parent transcript access controls.
- **[Architecture and internals](architecture.md):** Single-pass streaming internals, modular `scripts/hook/` dispatch, and single-use capability grant verification.
