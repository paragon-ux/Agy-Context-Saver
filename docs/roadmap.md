# Product Roadmap

`Agy-Context-Saver` focuses on three responsibilities for Google Antigravity (`agy`):
1. **Shell and file output control:** Offloads verbose shell commands and workspace searches to `RTK (>= 1.1.0)` and requires bounded `read_file` line slices (`<= 150` lines, or `1..TotalLines` on files `<= 800` lines and `<= 45 KiB`).
2. **Lifecycle and state governance:** Enforces Reactive Wakeup backoff on `manage_task` and `schedule`, blocks direct access to `.system_generated/` and `<stateDir>/`, expands unset `WaitMsBeforeAsync` to `10s`, and governs child transcript access via `agy-context transcript access` and `[agy-transcript-access: deny|self-only|allow]`.
3. **CLI transcript forensics:** Provides `agy-context transcript` (`read`, `query`, `step`, `health`, `list`, `export`, `access`) and `agy-context` (`status`, `setup`, `uninstall`, `restore-backups`) with zero MCP tool schema overhead. Multi-agent cohort planning and SHA-256 evidence bundling live in the separate [Agy-Squad](https://paragon-ux.github.io/Agy-Squad/) repository.

### Explicit Non-Goals
- **Not an issue tracker or review ledger:** Finding-to-disposition tables and review workflows belong in task-specific skills (such as `Agy-Squad`'s `/pr-review` and `/full-review`), not the hook or transcript CLI.
- **Not an OS sandbox:** Workspace isolation is handled by Antigravity worktrees (`share` / `branch`) or container boundaries, not regex path jails on normal project files.

---

## Phased Roadmap

![Agy-Context-Saver phased roadmap](assets/roadmap-phases.svg)

---

### Phase 1: Core Engine & CLI-First Governance *(Shipped in v2.0.0)*

1. **RTK `>= 1.1.0` delegation and bounded file slices:**
   - Delegated shell command rewriting to `rtk hook antigravity`, reverting lossy implicit `wc`/`ls`/`diff` rewrites and falling back to `rtk grep` when host `rg` is absent.
   - Enforced bounded `read_file` slices (`<= 150` lines, or full-file reads `<= 800` lines and `<= 45 KiB`) paired with `rtk grep`, `rtk find`, and `rtk ls`, while routing step spillovers and completed task logs to `rtk read`.
2. **CLI-first transcript engine (`bin/agy-context.mjs`, `lib/transcript-core.mjs`):**
   - Retired default MCP registration so idle sessions pay zero tool-schema token overhead.
   - Shipped `agy-context transcript` subcommands and aliases (`read` + `outline`/`summary`, `query` + `grep`/`search`/`find`/`tools`, `step` with multi-step ranges `N,M`, `N-M`, `N..M` and `--head`/`--tail`/`--full`, `health` + `stats`/`info`, `list` + `ls`, `access` + `policy`) plus `--field` projection, expanded in `v2.0.1` with `list --parent <uuid> --lineage` and sanitized `export --sanitized` (`dump`).
   - Registered the `PreToolUse` hook in both plugin `hooks.json` and global `~/.gemini/config/hooks.json` so `/swarm` workers inherit governance automatically.
3. **Parent transcript access governance:**
   - Added `agy-context transcript access` (`--status`, `--off`, `--on`, `--self-only`, `--mode`, `--allow`, `--deny`, `--ttl`) and first-line launch directives (`[agy-transcript-access: deny|self-only|allow]`).
   - Implemented the 5-tier precedence engine (`1. Policy Owner` -> `2. Explicit CLI --deny` -> `3. Explicit CLI --allow` with `@roster*` prefix globs -> `4. First-Line Launch Directive` -> `5. Cohort Default Mode`), 1-hour TTL parent-keyed policies with Step 0 `USER_INPUT` top-level session bypass, and 10-second single-use `PreToolUse` disk capability grants verified in `lib/transcript-core.mjs`.

---

### Phase 2: Ecosystem & Operational Validation *(Active)*

1. **Cross-platform and model compatibility:**
   - Triage edge cases surfaced by `agy-context status` and `agy-context transcript health` across Linux, macOS, and Windows.
   - Validate hook latency and CLI ergonomics against new Antigravity releases and model backends.
2. **Multi-plugin and `/swarm` stress testing:**
   - Verify co-existence with third-party hooks in `hooks.json` and external MCP servers in `mcp_config.json` without config contention.
   - Stress-test concurrent `/swarm` cohorts (`Agy-Squad` specialists and flat `audit-<id>` integrity auditors) to keep hook dispatch overhead minimal.
3. **Editor status visibility:**
   - Keep `rules/AGENTS.md`, `skills/context-governance/SKILL.md`, and `plugin.json` prompts concise and aligned with Antigravity UI panels.

---

### Phase 3: Modular Skills & Self-Healing Sync

1. **Standalone skills for specialized workflows:**
   - Keep high-ceremony workflows (compliance ledgers, blind evaluation harnesses) in opt-in Antigravity skills rather than the core hook.
2. **Zero-dependency standard library runtime:**
   - Maintain zero runtime npm dependencies (`fs`, `path`, `os`, `readline`, `child_process`, `crypto`), streaming transcripts line-by-line with cached RTK resolution and lazy `rg` discovery.
3. **Automated drift detection and repair:**
   - Use `agy-context setup` (`scripts/install-register.mjs`) to detect and repair hook or shim drift while preserving `.bak` configuration backups.
