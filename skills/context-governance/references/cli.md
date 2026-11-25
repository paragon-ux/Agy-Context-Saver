# `agy-context` CLI Reference

Run `agy-context` via `run_command` (`~/.gemini/antigravity/bin/agy-context`). `transcript health` is read-only and has no access policy. To inspect transcript contents, use native `read_file` (`<= 800L` slices) and `grep_search` on `transcript.jsonl`.

## 1. `agy-context transcript health` (aliases: `stats`, `info`)
Checks turn counts, step counts, raw transcript size, RTK status, and busy-polling events for a single session, comma-separated/repeatable `--id` list, or an entire parent cohort via `--parent <uuid|current>`.
```bash
agy-context transcript health [<id[,id...]>] [--id <conv[,conv...]>] [--parent <uuid|current>] [--json] [--file <path>]
```

## 2. `agy-context status`, `setup`, `uninstall` & `restore-backups`
Audits, synchronizes, removes, or restores backups for the plugin link, single global `PreToolUse` hook, CLI shims, RTK (`>= 1.1.0`) (run `uninstall` or `restore-backups` only when explicitly requested by the user; reload Antigravity Desktop IDE or start a new session after `setup` or `uninstall` so hook registrations update cleanly).
```bash
agy-context status [--json]
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
agy-context restore-backups
```
