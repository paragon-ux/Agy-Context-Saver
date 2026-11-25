# CLI & Hook Reference

`Agy-Context-Saver` (`v2.3.0`) provides the `agy-context` CLI (`bin/agy-context.mjs`, installed to `~/.gemini/antigravity/bin/agy-context`) and the single global `agy-context-saver` `PreToolUse` hook (`scripts/execution-guard-hook.mjs` routing dynamically to `scripts/hook/{file,shell,task}-guard.mjs`), paired with **RTK (`>= 1.1.0`)** via the Narrow High-ROI Pre-Gate (`AGY_RTK_MODE=pregate|off`, default `pregate`).

Native `read_file` and `grep_search` read Antigravity's `transcript.jsonl` files directly. `agy-context transcript health` is the only transcript command; it is read-only.

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

- **Aliases:** `stats`, `info`
- **Usage:** `agy-context transcript health [<id[,id...]>] [--id <uuid[,uuid...]>] [--parent <uuid|current>] [--file <path>] [--json]`

Streams `transcript.jsonl` to report step counts, user turns, tool call counts, transcript byte size, per-task and direct-subagent backoff-aware busy-polling events (`>= 30s` per task and `>= 180s` per conditioned direct subagent stall watchdog, while flagging `/swarm` one-shot polls and unconditioned loops), and local RTK status. Passing multiple `--id` values (comma-separated, repeatable, or positional) or `--parent <uuid|current>` emits a combined cohort health table (or structured `sessions[]` + `totals` JSON) in a single call.

| Flag / Argument | Value | Required | Description |
| :--- | :---: | :---: | :--- |
| `[<id[,id...]>]` / `--id` | `<uuid[,uuid...]>` | No* | One or more conversation UUIDs (positional, comma-separated, or repeatable `--id`). (*Omit to check the current session.) |
| `--parent` | `<uuid \| current>` | No | Audit health across all child sessions belonging to `<uuid>` in one call. |
| `--file` | `<path>` | No | Explicit path to `transcript.jsonl` inside Antigravity's brain roots (`antigravity`, `antigravity-cli`, `antigravity-ide`). |
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

## 2. `agy-context status`, `setup`, `uninstall` & `restore-backups`

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
