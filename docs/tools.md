# CLI & Hook Reference

`Agy-Context-Saver` (`v2.3.0`) provides the `agy-context` CLI (`bin/agy-context.mjs`, installed to `~/.gemini/antigravity/bin/agy-context`) and the single global `agy-context-saver` `PreToolUse` hook (`scripts/execution-guard-hook.mjs` routing dynamically to `scripts/hook/{file,shell,task,transcript}-guard.mjs`), paired with **RTK (`>= 1.1.0`)** via the Narrow High-ROI Pre-Gate (`AGY_RTK_MODE=pregate|off`, default `pregate`).

Native `read_file` and `grep_search` read Antigravity's `transcript.jsonl` files directly when the transcript mode is `open` (the default). The transcript commands are `agy-context transcript health` (read-only metrics) and `agy-context transcript access` (a parent-set read policy for the sessions it launches).

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

---

## Workspace File Bounds & Output Inspection

Native `grep_search`, `find_by_name`, and `list_dir` run directly on workspace paths (while staying blocked on `getStateDir()`). `read_file` and output inspection guardrails:

| Target | Enforced Guardrail |
| :--- | :--- |
| **Workspace files ($\le 800\text{L}$ & $\le 45\text{ KiB}$) & media** | Files $\le 800$ lines and $\le 45\text{ KiB}$, safe multimodal media (`.png`, `.jpg`, `.webp`, `.pdf`, audio/video), and Antigravity special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, own non-symlink `.system_generated/swarm/plan.json`, `swarm_view/`, `.gemini/config/`) need no line bounds. |
| **Large workspace files ($> 800\text{L}$ or $> 45\text{ KiB}$)** | Omitted bounds are denied; pass explicit `StartLine` and/or `EndLine` ($\le 800$ lines, EOF-clamped via $1\text{ MiB}$ newline scan, single-bound supported) to `read_file` / `view_file` (batch parallel $\le 800\text{L}$ slices in one turn when full coverage is needed). `read_many_files` and `ByteOffset`-only reads are denied. |
| **Spillovers & completed task logs** | Both `.system_generated/steps/<step>/output.txt` spillovers and `COMPLETED` `tasks/<taskId>.log` files allow bounded `read_file` ($\le 150\text{L}$) or single unchained `rtk read <path>` (`cat` and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`; `--head-lines 150` / `--tail-lines 150` required above `45 KiB`; `RUNNING` task logs are always denied). |

---

## 1. `agy-context transcript health`

The aliases are `stats` and `info`. Run:

```bash
agy-context transcript health [--id <uuid[,uuid...]|current>] [--parent <uuid|current>] [--json]
```

The command reports user and model turns, steps, tool calls, raw transcript bytes, polling violations, and unparsed lines for each selected session. Omit selectors to check the current session. Repeat `--id` or provide comma-separated UUIDs to check several sessions. Use `--parent` to check a parent's children; do not combine it with `--id`.

```bash
agy-context transcript health
agy-context transcript stats --id current
agy-context transcript info --parent current --json
```

Without `--json`, the command prints plain text for each session. JSON output has the form `{ "sessions": [...] }`; each session includes `id`, `file`, `status`, `turns`, `modelTurns`, `steps`, `toolCalls`, `rawBytes`, `pollingEvents`, and `corruptLines`.

| Status | Condition | Action |
| :--- | :--- | :--- |
| `HEALTHY` | No polling violations and at most 40 user turns | Continue normally. |
| `WARNING` | More than 40 user turns or one to three polling violations | Stop polling and consider starting a fresh conversation. |
| `CRITICAL` | More than three polling violations | Stop polling and wait for the completion message. |

A child in `self-only` mode may check itself with no selector, `--id current`, or its own UUID. It cannot check another session or a parent cohort. `deny` blocks every health check, including checks of the caller's own session.

---

## 2. `agy-context transcript access`

- **Usage:** `agy-context transcript access [status | set <open|self-only|deny>]`

Shows or sets which transcripts the sessions you launch may read. The session that runs `set` becomes the owner, and the policy applies to its descendants only (the nearest ancestor policy wins). It never restricts the owner. The hook enforces it, and only this command writes `transcript-policy.json` in the plugin state directory.

| Mode | Child session access |
| :--- | :--- |
| `open` (default) | Reads `transcript.jsonl` and `transcript_full.jsonl` natively, with bounded `read_file` slices, `grep_search`, or read-only shell commands. |
| `self-only` | Reads only its own transcript. Health checks allow only its own UUID or `current`; `--parent` is denied. |
| `deny` | Reads no transcripts. |

```bash
agy-context transcript access
agy-context transcript access set self-only
agy-context transcript access set open
```

See [Transcript Isolation](governance.md#transcript-isolation) for how enforcement works.

---

## 3. `agy-context status`, `setup`, `uninstall` & `restore-backups`

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
Overall Status: HEALTHY & ACTIVE
```
