# `agy-context` CLI Reference

Run `agy-context` via `run_command` (`~/.gemini/antigravity/bin/agy-context`). `transcript health` is read-only. To inspect transcript contents, use native `read_file` (`<= 800L` slices) and `grep_search` on `transcript.jsonl`; in `self-only` or `deny` mode the hook limits which transcripts a child session may read.

## 1. `agy-context transcript health` (aliases: `stats`, `info`)
Checks turn counts, step counts, raw transcript size, RTK status, and busy-polling events for a single session, comma-separated/repeatable `--id` list, or an entire parent cohort via `--parent <uuid|current>`.
```bash
agy-context transcript health [<id[,id...]>] [--id <conv[,conv...]>] [--parent <uuid|current>] [--json]
```
With `self-only`, `--id` and `--parent` are denied for child sessions.

## 2. `agy-context transcript access`
Sets which transcripts the sessions you launch may read. The session that runs `set` becomes the owner; the policy covers its descendants (nearest ancestor wins) and never limits the owner. The policy is stored in `transcript-policy.json` in the plugin state directory, which only this command writes.
```bash
agy-context transcript access            # same as status
agy-context transcript access status
agy-context transcript access set <open|self-only|deny>
```
- `open` (default): children read `transcript.jsonl` and `transcript_full.jsonl` natively.
- `self-only`: a child reads only its own transcript; sibling, parent, glob, and symlink paths are denied.
- `deny`: children read no transcripts.

## 3. `agy-context status`, `setup`, `uninstall` & `restore-backups`
Audits, synchronizes, removes, or restores backups for the plugin link, single global `PreToolUse` hook, CLI shims, RTK (`>= 1.1.0`) (run `uninstall` or `restore-backups` only when explicitly requested by the user; reload Antigravity Desktop IDE or start a new session after `setup` or `uninstall` so hook registrations update cleanly).
```bash
agy-context status [--json]
agy-context setup [--check] [--allow-degraded]
agy-context uninstall [--restore-backups]
agy-context restore-backups
```
