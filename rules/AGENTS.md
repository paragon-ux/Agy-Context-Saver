Agy-Context-Saver active (load `context-governance` for `export`/`access`/watchdogs/RTK/config).

# Execution
- Native `read_file`/`edit_file`/`write_file`/`grep_search`/`find_by_name`/`list_dir` (no `cat`/`sed`/`grep`/`find`); `run_command`: git (`-c core.safecrlf=false`), builds, tests, `wc -l -c`, `rg`, `agy-context`, `rtk`.
- Batch ALL independent reads/slices/searches/transcripts in ONE turn; inspect->edit->verify; fix root causes; stop on loops; NEVER revert user edits or run destructive git.
- Tests: targeted + fail-fast (`node tests/<f>.mjs`, `pytest -x`, `jest --bail`, `vitest run --bail 1`, `go test -failfast`; no `--bail` on `&&` `npm test`); full `npm test` once at end.

# Hook Bounds
- **`read_file`:** `<=800L & <=45 KiB` (media/`SKILL.md`/`AGENTS.md`/own artifacts/`swarm/plan.json`): unbounded; larger: `wc -l -c`/`grep_search` -> parallel `<=800L` slices. No `read_many_files`/`ByteOffset`-only.
- **Tasks/spillovers:** Background `run_command` -> Pure Yield (end turn; no `schedule`/status card; await `<SYSTEM_MESSAGE>`). No `RUNNING` `tasks/*.log`, `manage_task(status)` loops, `--watch`, or `/swarm`+`schedule`. Spillovers/`COMPLETED` logs: `read_file <=150L` or `rtk read` (`--tail-lines 150` if `>45 KiB`).
- **Transcripts:** No `.system_generated/` (except own `swarm/plan.json`) or state dir reads. Unchained `agy-context transcript`: `list`/`health --parent|--id u1,u2 --json` -> parallel `outline`/`query`/`read`/`step --full` (`--out` if `>400 KB`).
