Agy-Context-Saver active (load `context-governance` for watchdogs/RTK/config).

# Execution
- Native `read_file`/`edit_file`/`write_file`/`grep_search`/`find_by_name`/`list_dir` (no `cat`/`sed`/`grep`/`find`); `run_command`: `git -c core.safecrlf=false`, builds/tests, `wc -l -c`, `git grep -n`/`rg`, `agy-context`, `rtk`.
- Batch independent reads/slices/searches; inspect->edit->verify; fix root causes; stop on loops; NEVER revert user edits/destructive git.
- Tests: fail-fast (`node tests/<f>.mjs`, `pytest -x`, `jest --bail`, `vitest run --bail 1`, `go test -failfast`; no `--bail` on `&&` `npm test`); full suite once.

# Hook Bounds
- **`read_file`:** `<=800L/45 KiB` (media/`SKILL.md`/`AGENTS.md`/own artifacts/`swarm/plan.json`): ok; larger: `wc -l -c`/`grep_search` -> parallel `<=800L` slices. No `read_many_files`/`ByteOffset`-only.
- **Tasks/spillovers:** Async `run_command`: Pure Yield (end turn; await `<SYSTEM_MESSAGE>`); hang-risk/unattended: `timeout` or conditioned `schedule` (`TimerCondition=".../task-X"`). No `RUNNING` `tasks/*.log`, `status` polls, `--watch`, `/swarm`+`schedule`. Spillovers/`COMPLETED`: `read_file <=150L` or `rtk read` (`--tail-lines 150` >45 KiB).
- **Transcripts:** Read `transcript.jsonl` natively (`read_file <=800L`, `grep_search`); never write/delete `.system_generated/logs`. `agy-context transcript health [--id u1,u2|--parent <uuid>] --json` for turns/steps/size/polling.