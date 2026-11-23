---
name: context-governance
description: >-
  Use when running shell commands with large outputs, inspecting session transcript health
  via agy-context, preventing repetitive background polling loops, or inspecting codebases with RTK.
---

# Context Governance & Execution Guard (Agy-Context-Saver + RTK)

`Agy-Context-Saver` and `RTK` compress shell output, enforce bounded workspace file reads, stop background-task busy-polling, and provide CLI commands for conversation transcript inspection and access control.

## Architectural Boundary

- **RTK (`>= 1.1.0`)**: Compresses noisy test, build, lint, container, and `git status`/`push`/`pull`/`fetch` stdout via the Narrow High-ROI Pre-Gate (`AGY_RTK_MODE=pregate|off`, default `pregate`), reads step spillovers and completed task logs (`rtk read`), and remains available explicitly (`rtk <cmd>`, `rtk err`, `rtk summary`). Precision inspection tools (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, workspace `cat`/`head`/`tail`, `ps`, `git diff`/`show`/`log`), pipelines, redirects, and `--json`/`--porcelain` commands stay untouched and lossless (`2>&1` and `2>/dev/null` pass through).
- **Agy-Context-Saver (`v2.1.2`)**: Exposes the two-tier `agy-context transcript` CLI (`~9.2 KB` inline defaults + `--full`/`--out` `512 KB` deep mode) and enforces the Layer 1–3 `PreToolUse` guardrails detailed below (`rules/AGENTS.md` carries the concise Turn-1 starter prompt).

---

## Active Execution Guardrails (`PreToolUse` Hook Reference)

### Layer 1: Background Tasks, Remote CI & Proportional Backoff
- **Pure Yield default (no timer, no `schedule`, no Pre-Yield Status Card)**: When a local `run_command` moves to the background, stop calling tools and yield immediately so Antigravity's native Reactive Wakeup (`<SYSTEM_MESSAGE>`) wakes you once on process exit at zero intermediate token cost. Never poll `manage_task(Action='status')` in loops or schedule short/unconditioned task timers.
- **Opt-in conditioned stall watchdogs (`schedule`, e.g., unattended `/goal` or hang-prone jobs)**:
  - Bind strictly to the specific task (`TimerCondition="<convId>/task-X"`, which auto-cancels at zero cost on normal completion; hard hook floor stays `30s -> 75s -> 188s -> 469s -> 600s` with `15..required-1` auto-clamping, while `< 15s` or unconditioned task polls are denied). Size initial duration by job type to avoid early false wakeups:
    - Quick scripts, dev-server startup, or interactive-prompt hang risk: **`45-60s`**
    - Full local test suites & builds (`npm test`, `pytest`, `cargo build`): **`120-180s`**
    - Heavy integration, Docker, or E2E sweeps: **`300-600s`**
  - Never pair `/swarm` (`swarm_wait`) with a one-shot `schedule` timer (`swarm_monitor` handles stalls). Direct `invoke_subagent` runs may optionally arm a conditioned stall watchdog (`TimerCondition="<subagentConvId>"`, `180s -> 450s -> 600s`; `30..179s` auto-clamps; `< 30s` or unconditioned denied).
- **Per-task exponential backoff**: Tracked per task (`0s -> 30s -> 75s -> 188s -> 469s -> 600s`, pruned on completion). Check #1 (`0s`) is allowed **before** arming a `schedule` watchdog; afterward, `manage_task(Action='status')` waits for the watchdog cooldown. `manage_task(Action='kill')` and `send_input` are always allowed immediately (`0s`). Reading raw `.system_generated/tasks/*.log` while `RUNNING` is always denied. 5 cumulative denials trip `force_ask`.
- **Remote CI / PR checks**: Never run blocking CLI watches (`gh pr checks --watch`, `gh run watch`) inside `run_command`; run one-shot snapshots (`gh pr checks`, `gh run list`) and, if waiting on remote CI/PR builds/deployments (which have no local process-exit `<SYSTEM_MESSAGE>`), arm a backoff-compliant `schedule` timer (`>= 30s`, scaling `30s -> 75s -> 188s -> 469s -> 600s`; `15..required-1` auto-clamps; no local `task-X` `TimerCondition` required).

### Layer 2: Narrow High-ROI RTK Pre-Gate, File Bounds & Config Protection
- **Narrow High-ROI RTK Pre-Gate (`AGY_RTK_MODE=pregate|off`, default `pregate`)**: Delegates noisy runners (`pytest`, `python -m pytest`/`mypy`, `uv run pytest`/`ruff`/`mypy`/`ty`, `cargo`, `go`, `vitest`, `jest`, `tsc`, `eslint`, `ruff`, `npm`/`pnpm`/`bun` noisy `run` scripts & `lint`, `docker build`/`ps`/`logs`/`compose ps|logs|build`, `kubectl get`/`logs`/`describe`/`apply`, `git status`/`push`/`pull`/`fetch`) via `rtk hook antigravity` (explicit `rtk <cmd>` always works). Precision tools (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, `ps`, `git diff`/`show`/`log`, workspace `cat`/`head`/`tail`), pipes, stdout/file redirects, and machine-readable flags (`--json`, `--porcelain`, `git status -sb`, `-o json`, etc.) stay untouched and lossless.
- **Workspace discovery & `read_file` bounds**: Native `grep_search`, `find_by_name`, and `list_dir` work on workspace paths (blocked on `.system_generated/`, `getStateDir()`, and protected brain roots). On `read_file`:
  - Files `<= 800` lines and `<= 45 KiB`, safe media (`.png`, `.jpg`, `.webp`, `.pdf`, audio/video), and special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, own non-symlink `.system_generated/swarm/plan.json` for `read_file`/`write_file`/`edit_file`, `swarm_view/`, `.gemini/config/`) need no line bounds.
  - Larger files (`> 800` lines or `> 45 KiB`) require explicit `StartLine`/`EndLine` slices up to `800` lines (EOF-clamped up to `1 MiB`, single-bound supported; issue parallel `<= 800`-line slices in one turn when auditing a large file). `read_many_files` and `ByteOffset`-only reads are denied.
- **Spillovers & completed task logs**: Both `.system_generated/steps/<step>/output.txt` and `COMPLETED` `tasks/<taskId>.log` accept bounded `read_file` (`<= 150` lines) or single unchained `rtk read <path>` (`cat`/`head -n 150`/`tail -n 150` auto-rewrite to `rtk read`; `--head-lines 150` / `--tail-lines 150` required above `45 KiB`).
- **Brain subdirs & user config protection**: Direct access to `.system_generated/` (except own non-symlink `swarm/plan.json`) or `getStateDir()` is blocked across all brain roots. User-owned `scratch/`, `browser_sandbox/`, and `swarm_view/` brain subdirs allow nested `logs/`/`tasks/`/`steps/` paths (while `..`, `$`, dotfiles, `.system_generated/`, and `transcript*.jsonl` stay denied). Top-level unrestricted non-symlink edits to `~/.gemini/{config,antigravity*}/{mcp_config.json,config.json}` prompt via `force_ask`, while global `hooks.json`, `*.bak`, destructive shell verbs (`rm`, `mv`, `ln`, `truncate`, `shred`, `dd`, `chmod`, `chown`, `find`), ACS files, symlinks, and all child sessions stay hard-`deny`.

### Layer 3: Synchronous Window, Targeted Fail-Fast Tests & Benchmark Integrity
- **10s synchronous window**: Non-daemon `run_command` calls default to `WaitMsBeforeAsync: 10000` when omitted.
- **Targeted & fail-fast tests**: During iteration, run targeted test files with the runner's native fail-fast flag (`node tests/<suite>.mjs`, `pytest -x` / `--maxfail=1`, `jest --bail`, `vitest run --bail 1`, `go test -failfast`) so runs finish synchronously within the 10s window (never pass `--bail` to `&&`-chained `npm test` scripts, which forwards `--bail` only to the final command). Run the full `npm test` sweep once at final verification and yield in Pure Yield mode if it backgrounds.
- **Benchmark guard**: Edits to `benchmarks/`, `evaluation/`, `evaluators/`, `scoring/`, `ground_truth/`, or `prompt_templates/` prompt via `force_ask` (set `AGY_DISABLE_BENCHMARK_GUARD=1` in non-evaluation repos for top-level non-restricted sessions; restricted child sessions keep benchmark protection active).

---

## `agy-context` CLI Commands

Run `agy-context` via `run_command` (`~/.gemini/antigravity/bin/agy-context`). Invoke `agy-context transcript ...` as a single unchained command without `&&`, `||`, `;`, `|`, or redirects:

### 1. `agy-context transcript health` (aliases: `stats`, `info`)
Checks turn counts, step counts, raw transcript size, RTK status, and busy-polling events for a single session, comma-separated/repeatable `--id` list, or an entire parent cohort via `--parent <uuid|current>`.
```bash
agy-context transcript health [<id[,id...]>] [--id <conv[,conv...]>] [--parent <uuid|current>] [--json] [--file <path>]
```

### 2. `agy-context transcript read`
Streams recent conversation turns in Markdown (default ~`9.2 KB` inline ceiling with `nextCursor` hints), delegates to `query --summary --include-tools` when `--outline` is passed, or opts into the `512 KB` deep tier via `--full`/`--out`.
```bash
agy-context transcript read [<id>] [--id <conv>] [--mode compact|full] [--last-turns N] [--offset N] [--limit N] [--outline] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

### 3. `agy-context transcript query` (aliases: `grep`, `search`, `find`, `tools`, `outline`, `summary`)
Searches conversation transcripts by regex or substring with automatic dereferencing of truncated fields, role filtering (`user`, `assistant`, `subagent`, `tool`, `generic`, `system`, `error`, `all`), and `--full-args` / `--field` projection. Default inline outputs stay within ~`9.2 KB` (with `--summary` defaulting to `100` steps, `date=YYYY-MM-DD UTC` header compaction, duplicate tool collapse `(xN)`, boilerplate stripping with `[spill: steps/<N>]`, and compact `{ step_index, type, role, created_at, status, summary }` items on `--summary`/`outline --json`); `--full`, `--max-chars`, or `--out` opts into `512 KB` and raises the default step cap to `500` (keeping `--summary`/`outline` lines compact and `LARGE_BODY_ARG_KEYS` summarized unless `--full-args` is also passed). The `tools` alias defaults to `--roles assistant --field tool_args --include-tools`, and `outline` / `summary` map to `query --summary --include-tools`.
- **Recommended batched forensic workflow**:
  1. **Cohort discovery & metrics**: `agy-context transcript list --parent <uuid> --lineage` and `agy-context transcript health --parent <uuid> --json` (or `--id <u1,u2,...> --json`)
  2. **Batched `--full` audit (one parallel turn across sessions)**: `agy-context transcript outline --id <conv> --full` (compact 1-line timeline across all steps without spillover) or `agy-context transcript query --id <conv> --roles all --include-tools --full` (up to `500` steps; pass `--out <path>` for `> 400 KB` logs)
  3. **Targeted step extraction (only when specific truncated outputs remain)**: `agy-context transcript step <N,M,K|N..M> --id <conv> --field content --full` (batch-extract specific step outputs without 1-by-1 `--step <N>` loops)
```bash
agy-context transcript query [<pattern>] [<id>] [--id <conv>] [--query <regex>] [--roles csv] [--mode auto|compact|full] [--start N] [--end N] [--last-turns N] [--limit N] [--summary] [--include-tools] [--full-args] [--field content|thinking|tool_calls|tool_args|tool_args:Key|all] [--include-thinking] [--full] [--max-chars N] [--out <path>] [--json] [--file <path>]
```

### 4. `agy-context transcript step`
Extracts untruncated content or specific fields (`content`, `thinking`, `tool_calls`, `tool_args`, `tool_args:<Key>`, `all`) for one step or a batch/range of steps (`2,8,14`, `2-10`, `2..10`, or `--start 2 --end 10`) from `transcript_full.jsonl`, with optional `--head <N>`, `--tail <N>`, `--line-start <N>`..`--line-end <N>`, `--max-chars <N>`, `--out <path>`, and `--full` (`512 KB` unclamped mode). JSON output (`--json`) is deduplicated: `--field all` emits `step` (`steps[].step` in batch mode), while projected fields (`content`, `thinking`, `tool_calls`, `tool_args*`) emit only `data` (`steps[].data` in batch mode) without duplicating raw steps.
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
- **Stale-lock protection & immutable Tier 4 disclosure**: Parent CLI policies (`policies[ownerId]`) expire after a 1-hour default TTL (`--on`/`--reset` clears only parent overrides while immutable Tier 4 `deny`/`self-only` launch directives remain enforced), Step 0 `USER_INPUT` top-level user sessions bypass child locks automatically, Step 0/1 `sender=<parentConvId>` binds child agents to their parent policy, and both `agy-context transcript access --status` and `agy-context status` disclose active `launchRestrictions` alongside the parent CLI policy. Restricted children must not retry blocked transcript commands (5 denials trip `force_ask`).

### 8. `agy-context status`, `setup`, `uninstall` & `restore-backups`
Audits, synchronizes, removes, or restores backups for the plugin link, single global `PreToolUse` hook, CLI shims, RTK (`>= 1.1.0`), and `Transcript Access Policy` (run `uninstall` or `restore-backups` only when explicitly requested by the user; reload Antigravity Desktop IDE or start a new session after `setup` or `uninstall` so hook registrations update cleanly).
```bash
agy-context status [--json]
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
agy-context restore-backups
```
