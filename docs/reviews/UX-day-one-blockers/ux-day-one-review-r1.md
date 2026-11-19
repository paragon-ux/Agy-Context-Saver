# Agy-Context-Saver v2.0.4 Launch UX & Day-One Readiness Review (r1)

**Governing Standard:** Agy-Squad PR Review Standard 1.4.0
**Review type:** Launch UX & Day-One Merge Readiness Review (External User Onboarding & Runtime Ergonomics)
**Review date:** 2026-11-19
**Reviewer:** Senior DX & Plugin UX Reviewer (Subagent)
**Standard version:** 1.4.0

Content Verdict: PASS

---

## 1. Review metadata, Session Provenance, and evidence limits

### 1.1 Target

| Field | Value |
| --- | --- |
| Repository | `paragon-ux/Agy-Context-Saver` |
| Target | PR #10 (`fix/ux-day-one-blockers`), stacked on PR #9 (`fix/v2.0.4-rtk-read-parity`), v2.0.4 npm release candidate |
| Comparison base | `fix/v2.0.4-rtk-read-parity` (`8b5695c6aa75eb33ccbefc16fe0f128597db78bf`) |
| Head / tree | `fix/ux-day-one-blockers` (post-remediation verified tree) |
| Working-tree state | All 13 actionable findings (`UX-ACS-001` through `UX-ACS-013`) remediated with regression tests and full release verification gates |
| CI revision | Local post-final-edit verification (`npm test` 12/12, `npm run preflight`, `npm run verify:package`, `agy plugin validate --strict --json`, boundary grep, em-dash check) |
| Prior review | Session 1 initial Launch UX & Day-One Readiness review `r1` (`8b5695c6aa75eb33ccbefc16fe0f128597db78bf`) |

### 1.2 Session Provenance

| Session # | Operator Conversation ID | Parent Session | Date | Base..Head + Working-Tree State | Skill / Topology Invoked |
| --- | --- | --- | --- | --- | --- |
| 1 | `04291507-36ae-4728-a17a-149dbb4714f7` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `fix/v2.0.4-rtk-read-parity` @ `8b5695c6aa75eb33ccbefc16fe0f128597db78bf` (read-only) | Read-only Launch UX Reviewer subagent |
| 2 | `e835beb8-0ad2-44fb-a713-108519c18ec8` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `8b5695c6aa75eb33ccbefc16fe0f128597db78bf..fix/ux-day-one-blockers` (remediated & verified) | Launch UX Remediation Subagent (`PR #10`) |

### 1.3 Evidence available

- Full source inspection of user-facing onboarding, metadata, installer, CLI, hook, rules, skill, and documentation surfaces on disk: `README.md`, `plugin.json`, `package.json`, `hooks.json`, `install.sh`, `install.ps1`, `zensical.toml`, `assets/logo.svg`, `rules/AGENTS.md`, `skills/context-governance/SKILL.md`, `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, `scripts/execution-guard-hook.mjs`, `bin/agy-context.mjs`, `docs/index.md`, `docs/installation.md`, `docs/tools.md`, `docs/governance.md`, `docs/architecture.md`, `docs/publishing.md`, `docs/roadmap.md`, `docs/INSTALLER-HARDENING.md`, and `docs/RTK-SUPPORT-MATRIX.md`.
- Session 2 automated verification across all 12 test suites (`npm test`), `npm run preflight`, `npm run verify:package` (`32` packaged files, `docs/plans/**` and `docs/reviews/**` excluded), `agy plugin validate --strict --json` (`0` findings), public-boundary leak grep, and prose em-dash check.

### 1.4 Evidence limits

- Physical macOS and Windows Antigravity Desktop IDE GUI sessions were not executed in this Linux environment; Windows `.cmd` shim formatting, `node.cmd` wrapper parity, and PowerShell `PATH` onboarding are covered by deterministic cross-platform unit tests in `tests/test-lifecycle-rollback.mjs` and `tests/test-rtk-ledger-fresh-install.mjs`.
- Antigravity host `PreToolUse` stdin JSON payload schemas do not currently disclose whether a caller session exposes `run_command` (tracked in Section 8 as `UX-ACS-014`).

---

## 2. File/artifact-to-category inventory and coverage matrix

| Artifact | Role | Primary category | Cross-references | Coverage |
| --- | --- | --- | --- | --- |
| `README.md` | First-60-seconds landing page and quickstart | DOC | SCRIPT, DEP | Complete |
| `plugin.json` | Antigravity plugin card, logo, suggestedPrompts | DEP | SCRIPT, RUN | Complete |
| `package.json` | npm package manifest, `bin` entries, `files` whitelist | DEP | TEST, SCRIPT | Complete |
| `hooks.json` | Plugin `PreToolUse` hook registration | RUN | DEP | Complete |
| `assets/logo.svg` | Plugin shield icon SVG | DEP | DOC | Complete |
| `zensical.toml` | Docs site navigation and theme configuration | DOC | None | Complete |
| `install.sh`, `install.ps1` | POSIX and Windows installer wrappers (`node.cmd`) | SCRIPT | DOC, DEP | Complete |
| `scripts/install-register.mjs` | Cross-platform setup, status, check, uninstall, backup restore | SCRIPT | RUN, DOC, DEP | Complete |
| `scripts/provision-rtk.mjs` | RTK >= 1.1.0 SHA-256 download, `config.toml`, global git config | SCRIPT | RUN, DOC | Complete |
| `scripts/execution-guard-hook.mjs` | `PreToolUse` hook: RTK delegation, file slicing, backoff, access control | RUN | SVC, SCRIPT, SKILL | Complete (UX surfaces) |
| `bin/agy-context.mjs` | CLI entrypoint, help text, subcommand validation, error UX | SCRIPT | SVC, DOC | Complete |
| `rules/AGENTS.md` | Auto-loaded Antigravity session rulebook | SKILL | RUN, DOC | Complete |
| `skills/context-governance/SKILL.md` | Context governance skill instructions | SKILL | RUN, DOC | Complete |
| `docs/index.md`, `docs/installation.md`, `docs/tools.md`, `docs/governance.md`, `docs/architecture.md`, `docs/publishing.md`, `docs/roadmap.md`, `docs/INSTALLER-HARDENING.md`, `docs/RTK-SUPPORT-MATRIX.md` | Public user and maintainer documentation | DOC | SCRIPT, RUN, TEST | Complete |

| Category | Scope covered | Coverage | Verdict |
| --- | --- | --- | --- |
| ARCH | Architectural boundary across hook, CLI, RTK, and companion `Agy-Squad` | Complete | No findings within reviewed scope |
| DOC | `README.md`, `zensical.toml`, `docs/*.md` | Complete | Pass (all findings closed in Session 2) |
| SKILL | `rules/AGENTS.md`, `skills/context-governance/SKILL.md` | Complete | Pass (all findings closed in Session 2) |
| MCP | Legacy v1.x MCP retirement contract (no active MCP server in v2.0.4) | Complete | Not applicable |
| RUN | `hooks.json`, `scripts/execution-guard-hook.mjs` UX paths and denial messaging | Complete | Pass (all findings closed in Session 2) |
| SVC | Transcript inspection, lineage, and parent access control UX (`bin/agy-context.mjs`, `docs/governance.md`) | Complete | No findings within reviewed scope |
| DB | Filesystem JSON/JSONL state only (no SQL/database layer) | Complete | Not applicable |
| SCRIPT | `install.sh`, `install.ps1`, `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, `bin/agy-context.mjs` | Complete | Pass (all findings closed in Session 2) |
| TEST | Full 12-suite test matrix (`npm test`) with Session 2 regressions for `UX-ACS-001`..`UX-ACS-013` | Complete | Pass (12/12 suites passing) |
| DEP | `package.json`, `plugin.json`, `assets/logo.svg`, zero-dependency packaging | Complete | No findings within reviewed scope |

---

## 3. UX Launch Contract Trace

Each Day-1 user journey is traced along `user journey -> contract/doc -> implementation -> verification`:

| User journey | Promised contract / doc | Actual implementation (Session 2) | Verification | Result |
| --- | --- | --- | --- | --- |
| Fresh `npx` install without pre-installed `rtk` | `README.md`, `docs/installation.md`, `docs/RTK-SUPPORT-MATRIX.md`: auto-provisioned `rtk` works across all `rtk` discovery and log-reading commands | `scripts/execution-guard-hook.mjs` rewrites explicit `rtk ...` to local `rtkPrefix` when absent from `PATH`; `scripts/install-register.mjs` installs a managed `rtk`/`rtk.cmd` shim into `~/.gemini/antigravity/bin/` (removed on uninstall only if managed) | Automated regressions in `tests/test-hook.mjs` (Group J.1) and `tests/test-lifecycle-rollback.mjs` (Section 5) | Match (`UX-ACS-001` Closed) |
| Offline / Windows ARM64 install with `--allow-degraded` | `docs/RTK-SUPPORT-MATRIX.md`, `scripts/install-register.mjs`: hook-only governance without RTK | `scripts/execution-guard-hook.mjs` gates `grep_search`/`find_by_name`/`list_dir` and `rtk read` mandates on `resolveCachedHostEnv().rtk`, updates `read_file`/`read_many_files` guidance to raw `rg`/`grep -rnE`, and allows single unchained bounded `head -n 150`/`tail -n 150` on completed task logs and spillovers while keeping `.system_generated/` and running task logs denied | Automated regressions in `tests/test-hook.mjs` (Group J.2) and `tests/test-output-governance.mjs` (Group 2) | Match (`UX-ACS-002` Closed) |
| Quickstart verify (`agy-context status`) and IDE `suggestedPrompts` | `README.md`, `docs/installation.md`, `plugin.json`: immediate verification and `suggestedPrompts` work out of the box | `scripts/install-register.mjs` checks `PATH` in `runInstall()` and `runStatus()` with copy-paste POSIX/PowerShell export snippets and `npx` fallback; `scripts/execution-guard-hook.mjs` rewrites bare `agy-context` to installed shim (falling back to `node "<pluginDest>/bin/agy-context.mjs"`); documented in `README.md` and `docs/installation.md` | Automated regressions in `tests/test-lifecycle-rollback.mjs` (Section 5) and `tests/test-hook.mjs` (Group J.3) | Match (`UX-ACS-003` Closed) |
| Non-destructive installer guarantee | `docs/INSTALLER-HARDENING.md`, `docs/RTK-SUPPORT-MATRIX.md`: only documented config mutations with backups and clean uninstall | Removed silent `git config --global core.safecrlf false` mutation from `scripts/provision-rtk.mjs`; retained per-command `git -c core.safecrlf=false` rule in `rules/AGENTS.md` | Automated assertions in `tests/test-rtk-ledger-fresh-install.mjs` and `tests/test-lifecycle-rollback.mjs` verifying `GIT_CONFIG_GLOBAL` stays untouched | Match (`UX-ACS-004` Closed) |
| Everyday coding in unrelated user repositories | Transparent compression and safe file slicing without breaking user tests or normal app directories | `scripts/execution-guard-hook.mjs` scopes `XDG_STATE_HOME`/`LOCALAPPDATA` to restricted children and governance-targeting commands; adds `AGY_DISABLE_BENCHMARK_GUARD=1` opt-out for top-level non-restricted sessions and documents it in `docs/governance.md` | Automated regressions in `tests/test-hook.mjs` (Group J.4 and Group J.5) | Match (`UX-ACS-007`, `UX-ACS-008` Closed) |
| Clean uninstall and CLI discoverability | `README.md`, `docs/installation.md`, `bin/agy-context.mjs` | `docs/installation.md` leads with global `agy-context uninstall` / `npx` fallback; `bin/agy-context.mjs` emits compact `<= 100`-char top-level help + 4 examples and dedicated `printSubcommandHelp()` for every subcommand; `status` prints a 1-line setup hint on `NOT INSTALLED` / `PARTIAL INSTALLATION` | Automated regressions in `tests/test-transcript.mjs` (Section 11) and `tests/test-lifecycle-rollback.mjs` (Section 5) | Match (`UX-ACS-005`, `UX-ACS-011`, `UX-ACS-012`, `UX-ACS-013` Closed) |

---

## 4. Category reviews

### 4.1 `ARCH`: Architecture and contracts
- **Scope:** Overall architectural boundary between `PreToolUse` hook, `agy-context` CLI, RTK >= 1.1.0, and companion `Agy-Squad` (`README.md`, `docs/architecture.md`, `docs/roadmap.md`).
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope (host `PreToolUse` toolset-visibility limitation tracked in Section 8 as `UX-ACS-014`).
- **Verification:** Source inspection of `docs/architecture.md`, `docs/roadmap.md`, `scripts/execution-guard-hook.mjs`, and `scripts/install-register.mjs`.
- **Category Verdict:** No findings within reviewed scope.

### 4.2 `DOC`: Documentation and change records
- **Scope:** `README.md`, `zensical.toml`, `docs/index.md`, `docs/installation.md`, `docs/tools.md`, `docs/governance.md`, `docs/architecture.md`, `docs/publishing.md`, `docs/roadmap.md`, `docs/INSTALLER-HARDENING.md`, `docs/RTK-SUPPORT-MATRIX.md`.
- **Coverage:** Complete.
- **P1 (high priority):** None open (`PATH` doc gap closed under `UX-ACS-003`; global `~/.gitconfig` mutation removed under `UX-ACS-004`).
- **P2 (medium priority):** `UX-ACS-005` (Closed), `UX-ACS-009` (Closed).
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Updated `README.md`, `docs/installation.md`, `docs/tools.md`, `docs/governance.md`, `docs/INSTALLER-HARDENING.md`, and `zensical.toml`; verified with `npm run preflight`, `npm run verify:package`, public-boundary grep, and zero prose em dashes.
- **Category Verdict:** Pass (all findings closed in Session 2).

### 4.3 `SKILL`: Skills and agent instructions
- **Scope:** `rules/AGENTS.md`, `skills/context-governance/SKILL.md`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** `UX-ACS-010` (Closed).
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed zero `$` TeX delimiters in `rules/AGENTS.md` and `skills/context-governance/SKILL.md`, plus `agy plugin validate --strict --json` (`0` findings).
- **Category Verdict:** Pass (all findings closed in Session 2).

### 4.4 `MCP`: MCP schemas and public API
- **Scope:** v2.0.4 retired the default MCP server in favor of the CLI-first `agy-context` binary (`README.md`, `docs/publishing.md`). Legacy MCP retirement logic in `scripts/install-register.mjs` was reviewed under `SCRIPT`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Source inspection of `package.json`, `scripts/install-register.mjs`, and `docs/publishing.md`.
- **Category Verdict:** Not applicable (no active MCP server shipped in v2.0.4).

### 4.5 `RUN`: Core runtime, parsing, and validation
- **Scope:** `hooks.json`, `scripts/execution-guard-hook.mjs` (RTK rewrite post-processing, degraded-mode handling, `agy-context` command routing, internal-state env checks, benchmark protection, and denial messages).
- **Coverage:** Complete across all user-facing UX and everyday-coding runtime paths.
- **P0 (critical launch blocker):** `UX-ACS-001` (Closed).
- **P1 (high priority):** `UX-ACS-002` (Closed).
- **P2 (medium priority):** `UX-ACS-007` (Closed), `UX-ACS-008` (Closed).
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Automated regression tests in `tests/test-hook.mjs` (Group J) and `tests/test-output-governance.mjs` (Group 2); full `npm test` 12/12 passing.
- **Category Verdict:** Pass (all findings closed in Session 2).

### 4.6 `SVC`: Services, orchestration, and audit semantics
- **Scope:** Transcript streaming, lineage parsing, 5-tier parent transcript access precedence, and single-use capability grants (`bin/agy-context.mjs`, `scripts/execution-guard-hook.mjs`, `docs/governance.md`).
- **Coverage:** Complete across UX-facing command and error semantics.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Source inspection of `bin/agy-context.mjs`, `scripts/execution-guard-hook.mjs#L2101-L3064`, and `docs/governance.md`.
- **Category Verdict:** No findings within reviewed scope.

### 4.7 `DB`: Database, migrations, replay, and concurrency
- **Scope:** Filesystem JSON/JSONL state only (`getStateDir()`, `transcript.jsonl`); no relational or embedded database exists.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed filesystem-only state persistence in `scripts/execution-guard-hook.mjs#L107-L190`.
- **Category Verdict:** Not applicable (filesystem-only state persistence covered under `RUN` and `SCRIPT`).

### 4.8 `SCRIPT`: Scripts, evaluation, and developer tooling
- **Scope:** `install.sh`, `install.ps1`, `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, `bin/agy-context.mjs`.
- **Coverage:** Complete.
- **P1 (high priority):** `UX-ACS-003` (Closed), `UX-ACS-004` (Closed).
- **P2 (medium priority):** `UX-ACS-006` (Closed), `UX-ACS-011` (Closed).
- **P3 (low priority):** `UX-ACS-012` (Closed), `UX-ACS-013` (Closed).
- **Verification:** Automated regressions in `tests/test-lifecycle-rollback.mjs` (Section 5), `tests/test-rtk-ledger-fresh-install.mjs`, and `tests/test-transcript.mjs` (Section 11).
- **Category Verdict:** Pass (all findings closed in Session 2).

### 4.9 `TEST`: Tests and CI
- **Scope:** Full 12-suite test matrix in `package.json`, `docs/publishing.md`, and `docs/INSTALLER-HARDENING.md`, plus Session 2 UX regression tests.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Executed `npm test` (12/12 passing), `npm run preflight` (PASS), `npm run verify:package` (`32` files verified), and `agy plugin validate --strict --json` (`0` findings).
- **Category Verdict:** Pass (12/12 suites passing).

### 4.10 `DEP`: Dependencies, packaging, and configuration
- **Scope:** `package.json`, `plugin.json`, `assets/logo.svg`, zero-runtime-dependency boundary.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope (`plugin.json#L7-L11` `suggestedPrompts` Day-1 failure root-caused under `UX-ACS-003`).
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Source inspection of `package.json`, `plugin.json`, and `assets/logo.svg`.
- **Category Verdict:** No findings within reviewed scope.

---

## 5. Findings

### 5.1 P0/P1/P2 finding records

#### `UX-ACS-001`: Auto-provisioned local `rtk` binary is not rewritten onto explicit `rtk ...` commands when `rtk` is absent from `PATH` | P0 | Closed

1. **Title, priority, status:** Auto-provisioned local `rtk` binary is not rewritten onto explicit `rtk ...` commands when `rtk` is absent from `PATH`, P0, Closed.
2. **Contract provenance:** `README.md#L25`, `docs/installation.md#L11`, and `docs/RTK-SUPPORT-MATRIX.md#L10` promise that `agy-context setup` automatically downloads `rtk` into `bin/` so all `rtk` discovery and log-reading workflows (`rules/AGENTS.md#L36-L44`) work without a separate manual `PATH` install.
3. **Source evidence:** `scripts/execution-guard-hook.mjs` (`postProcessSegmentText`), `scripts/install-register.mjs` (`installManagedRtkShim`, `isManagedAgyShimFile`, `formatManagedRtkShims`, `runInstall`, `runUninstall`), `scripts/provision-rtk.mjs` (`verifyLocalRtkBinary`).
4. **Trigger:** A developer without `rtk` on system `PATH` runs `npx --package=agy-context-saver agy-context setup`, which places `rtk` solely inside `~/.gemini/config/plugins/agy-context-saver/bin/rtk`. In Antigravity, the hook denies `list_dir`, `find_by_name`, `grep_search`, and unbounded `read_file` and instructs the agent to run `rtk ls .`, `rtk find .`, `rtk read <path>`, or `rtk grep -rnE ...` via `run_command`.
5. **Expected / actual:** Expected (contract): `PreToolUse` rewrites bare `rtk ...` invocations to the resolved plugin-local binary path (`rtkPrefix`, e.g., `~/.gemini/config/plugins/agy-context-saver/bin/rtk`) so the command succeeds. Fixed in Session 2: removed `&& !/^rtk\s+/i.test(rawMatchTarget)` in `postProcessSegmentText()` so explicit `rtk ...` commands rewrite to `rtkPrefix` whenever `rtk` resolves locally; added managed `rtk`/`rtk.cmd` shim provisioning (`agy-context-saver-managed` marker) in `~/.gemini/antigravity/bin/` with safe uninstall that never overwrites or removes an unmanaged user `rtk` binary.
6. **Impact:** Catastrophic Day-1 breakage for fresh `npx` users relying on auto-provisioned `rtk` is eliminated.
7. **Required remediation:** Completed in Session 2 (`scripts/execution-guard-hook.mjs`, `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`).
8. **Acceptance evidence:** Verified by `tests/test-hook.mjs` (Group J.1: `rtk ls`, `rtk find`, `rtk read`, `rtk grep`, `rtk err`, `rtk summary` with and without `rg`) and `tests/test-lifecycle-rollback.mjs` (Section 5: managed `rtk` shim install, execution, clean removal, and unmanaged user `rtk` preservation).
9. **Root cause / related IDs:** Overly restrictive rewrite guard on `rawMatchTarget` combined with local-only binary placement; related to `UX-ACS-002` and `UX-ACS-003`.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-002`: `--allow-degraded` mode without `rtk` deadlocks codebase search and spillover/task log inspection | P1 | Closed

1. **Title, priority, status:** `--allow-degraded` mode without `rtk` deadlocks codebase search and spillover/task log inspection, P1, Closed.
2. **Contract provenance:** `docs/RTK-SUPPORT-MATRIX.md#L11`, `docs/RTK-SUPPORT-MATRIX.md#L21`, and `scripts/install-register.mjs` promise `--allow-degraded` provides working hook-only governance without RTK (required for Windows ARM64 and airgapped/proxy networks).
3. **Source evidence:** `scripts/execution-guard-hook.mjs` (`parseDegradedBoundedHeadTailCommand`, Section 1 spillover/task checks, Section 2a/2b/2e/2f `!rtk` degradation).
4. **Trigger:** A developer installs with `agy-context setup --allow-degraded` (no `rtk` on `PATH` or in plugin `bin/`), then runs Antigravity in their repo and invokes `grep_search`, `find_by_name`, `list_dir`, `read_many_files`, unbounded `read_file`, or inspects a completed background task log.
5. **Expected / actual:** Fixed in Session 2: when `resolveCachedHostEnv().rtk` is `null`, `grep_search`, `find_by_name`, and `list_dir` pass through while `.system_generated/` protection and bounded `read_file` slicing remain enforced; `read_file` and `read_many_files` guidance recommends raw `rg`/`grep -rnE` and bounded `head -n 150`/`tail -n 150` without mentioning `rtk`; single unchained bounded `head -n 150`/`tail -n 150` on completed task logs and spillovers are allowed while running task logs, oversized/unbounded reads, multi-operand reads, and raw transcripts stay denied.
6. **Impact:** Windows ARM64 and offline `--allow-degraded` installs now retain full discovery and completed log inspection without deadlocking.
7. **Required remediation:** Completed in Session 2 (`scripts/execution-guard-hook.mjs`).
8. **Acceptance evidence:** Verified by `tests/test-hook.mjs` (Group J.2) and `tests/test-output-governance.mjs` (Group 2 degraded-mode matrix).
9. **Root cause / related IDs:** Unconditional RTK-routing checks in Sections 1 and 2 of `execution-guard-hook.mjs` omitted a `!rtk` guard; related to `UX-ACS-001`.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-003`: Zero `PATH` onboarding for `~/.gemini/antigravity/bin` breaks Quickstart `agy-context status` and `plugin.json` `suggestedPrompts` | P1 | Closed

1. **Title, priority, status:** Zero `PATH` onboarding for `~/.gemini/antigravity/bin` breaks Quickstart `agy-context status` and `plugin.json` `suggestedPrompts`, P1, Closed.
2. **Contract provenance:** `README.md`, `docs/index.md`, `docs/installation.md`, and `plugin.json` instruct users and Antigravity agents to run bare `agy-context status`, `agy-context uninstall`, and `agy-context transcript ...` immediately after `npx --package=agy-context-saver agy-context setup`.
3. **Source evidence:** `scripts/install-register.mjs` (`isDirOnPath`, `formatPathOnboardingLines`, `detectCliShims`, `runInstall`, `runStatus`), `scripts/execution-guard-hook.mjs` (`resolveInstalledAgyContextCommand` + bare `agy-context` rewrite), `README.md`, `docs/installation.md`.
4. **Trigger:** A developer installs via `npx --package=agy-context-saver agy-context setup` on a machine where `~/.gemini/antigravity/bin` is not already on shell `PATH`, then runs `agy-context status` or clicks any `suggestedPrompt` in Antigravity Desktop IDE.
5. **Expected / actual:** Fixed in Session 2: `runInstall()` and `runStatus()` inspect `process.env.PATH` (case-insensitive on Windows/macOS, normalized trailing slashes and symlinks) and emit exact copy-paste POSIX/PowerShell export commands plus `npx --package=agy-context-saver agy-context status|uninstall` fallback when absent; `execution-guard-hook.mjs` rewrites bare `agy-context`/`agy-context-saver` commands to the installed shim (falling back to `node "<pluginDest>/bin/agy-context.mjs"`) when absent from `PATH`; `README.md` and `docs/installation.md` document both `PATH` setup and `npx` fallback.
6. **Impact:** Quickstart commands and all 3 IDE `suggestedPrompts` now work out of the box on fresh machines.
7. **Required remediation:** Completed in Session 2 (`scripts/install-register.mjs`, `scripts/execution-guard-hook.mjs`, `README.md`, `docs/installation.md`).
8. **Acceptance evidence:** Verified by `tests/test-lifecycle-rollback.mjs` (Section 5: `PATH` warning emitted when absent, omitted when present, cross-platform `isDirOnPath` and Windows PowerShell snippet unit tests) and `tests/test-hook.mjs` (Group J.3: installed shim rewrite, on-PATH pass-through, and plugin CLI fallback).
9. **Root cause / related IDs:** Installer placed shims outside standard system `PATH` directories without user onboarding or hook fallback resolution; mirrors `UX-SQ-005` in `Agy-Squad`.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-004`: Silent, undocumented, non-reversible global `~/.gitconfig` mutation (`core.safecrlf = false`) during setup | P1 | Closed

1. **Title, priority, status:** Silent, undocumented, non-reversible global `~/.gitconfig` mutation (`core.safecrlf = false`) during setup, P1, Closed.
2. **Contract provenance:** `docs/INSTALLER-HARDENING.md` and `docs/RTK-SUPPORT-MATRIX.md` commit to transparent, minimal, non-destructive configuration changes; `rules/AGENTS.md` already specifies per-command `git -c core.safecrlf=false`.
3. **Source evidence:** `scripts/provision-rtk.mjs` (`ensureRtkConfigured`), `rules/AGENTS.md#L59`.
4. **Trigger:** Any developer runs `agy-context setup` (`npx --package=agy-context-saver agy-context setup`).
5. **Expected / actual:** Fixed in Session 2: removed `ensureGitLineEndingConfigured()` and its unconditional `git config --global core.safecrlf false` mutation from `scripts/provision-rtk.mjs`; retained the non-invasive per-command `git -c core.safecrlf=false` rule in `rules/AGENTS.md`.
6. **Impact:** Global `~/.gitconfig` settings (`core.safecrlf = true` / `warn`) are never altered during installation.
7. **Required remediation:** Completed in Session 2 (`scripts/provision-rtk.mjs`).
8. **Acceptance evidence:** Verified by `tests/test-rtk-ledger-fresh-install.mjs` and `tests/test-lifecycle-rollback.mjs` (Section 5) asserting pre-existing `core.safecrlf = true` in `GIT_CONFIG_GLOBAL` and host `~/.gitconfig` remain completely untouched.
9. **Root cause / related IDs:** Convenience Git setting was coupled into `ensureRtkConfigured()` without disclosure or rollback.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-005`: `docs/installation.md` uninstall section shows only local-checkout commands | P2 | Closed

1. **Title, priority, status:** `docs/installation.md` uninstall section shows only local-checkout commands, P2, Closed.
2. **Contract provenance:** `docs/installation.md` designates `Option 1: NPX Global Registration (Recommended)` as the primary install method, and `README.md` documents global `agy-context uninstall`.
3. **Source evidence:** `docs/installation.md` (`## Clean Uninstallation & Rollback`).
4. **Trigger:** An `npx`-installed user consults `docs/installation.md` to uninstall or roll back `Agy-Context-Saver` from their own project directory.
5. **Expected / actual:** Fixed in Session 2: updated `docs/installation.md` to lead with `agy-context uninstall`, `agy-context uninstall --restore-backups`, and `npx --package=agy-context-saver agy-context uninstall [--restore-backups]`, clearly labeling `npm run uninstall` / `node scripts/install-register.mjs` as local-checkout commands.
6. **Impact:** External `npx` users now have direct copy-paste uninstall commands that work from any directory.
7. **Required remediation:** Completed in Session 2 (`docs/installation.md`).
8. **Acceptance evidence:** Reconciled `docs/installation.md` against `README.md`; verified `npm run preflight` and `npm run verify:package`.
9. **Root cause / related IDs:** Docs carried over from pre-npx checkout workflow; related to `UX-ACS-003`.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-006`: Windows `npx` vs. `install.ps1` `node.cmd` divergence and missing post-install reload guidance | P2 | Closed

1. **Title, priority, status:** Windows `npx` vs. `install.ps1` `node.cmd` divergence and missing post-install reload guidance, P2, Closed.
2. **Contract provenance:** `README.md` and `docs/installation.md` promise first-class cross-platform parity across Linux, macOS, and Windows Desktop IDE and `agy` CLI.
3. **Source evidence:** `scripts/install-register.mjs` (`formatWindowsNodeCmdWrapper`, `installWindowsNodeCmdWrapper`, `runInstall` `Next steps:` block), `docs/installation.md`, `docs/INSTALLER-HARDENING.md`.
4. **Trigger:** A Windows user installs via `npx --package=agy-context-saver agy-context setup`, or any Desktop IDE user runs `setup` while Antigravity IDE is already open.
5. **Expected / actual:** Fixed in Session 2: added a post-install `Next steps:` block in `runInstall()` instructing users to reload Antigravity Desktop IDE or start a new session and verify with `agy-context status`; added managed `~/.gemini/config/node.cmd` provisioning (`installWindowsNodeCmdWrapper`) inside `runInstall()` on `win32` with identical `agy-context-saver-managed` marker and `.bak` backup preservation matching `install.ps1`; documented parity in `docs/installation.md` and `docs/INSTALLER-HARDENING.md`.
6. **Impact:** Windows `npx` setup now matches `install.ps1` behavior and all platforms clearly prompt users to start a new session/reload IDE.
7. **Required remediation:** Completed in Session 2 (`scripts/install-register.mjs`, `docs/installation.md`, `docs/INSTALLER-HARDENING.md`).
8. **Acceptance evidence:** Verified by `tests/test-lifecycle-rollback.mjs` (Section 5: `Next steps:` output assertion, `formatWindowsNodeCmdWrapper` format checks, and `installWindowsNodeCmdWrapper` `.bak` preservation + restore).
9. **Root cause / related IDs:** Split logic between PowerShell wrapper `install.ps1` and cross-platform `scripts/install-register.mjs`.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-007`: Normal user test commands setting `XDG_STATE_HOME=` or `LOCALAPPDATA=` are false-positive denied as internal state access | P2 | Closed

1. **Title, priority, status:** Normal user test commands setting `XDG_STATE_HOME=` or `LOCALAPPDATA=` are false-positive denied as internal state access, P2, Closed.
2. **Contract provenance:** `docs/roadmap.md#L10` states `Agy-Context-Saver` is not a regex path jail on normal project files and protects `.system_generated/` and `<stateDir>/` without impeding ordinary repository development.
3. **Source evidence:** `scripts/execution-guard-hook.mjs` (`isProtectedShellOrScriptOperation`, plus `{ isRestrictedChild }` call sites in Sections 1 and 4).
4. **Trigger:** An agent working in an external user's CLI/desktop repo runs a standard isolated test command such as `XDG_STATE_HOME=/tmp/test-state pytest` or `LOCALAPPDATA=/tmp/app npm test`.
5. **Expected / actual:** Fixed in Session 2: kept `AGY_TEST_PROFILE_DIR`, `AGY_BRAIN_DIR`, and `GEMINI_CONVERSATION_ID` unconditionally protected, and scoped `XDG_STATE_HOME`/`LOCALAPPDATA` blocking to restricted child sessions or commands/scripts referencing `agy-context`, `agy-context-saver`, `execution-guard`, `transcript`, `transcript-access`, `transcript-core`, or `.gemini`.
6. **Impact:** Developers building CLI/XDG/Windows apps can run isolated test commands cleanly while governance state isolation stays enforced.
7. **Required remediation:** Completed in Session 2 (`scripts/execution-guard-hook.mjs`).
8. **Acceptance evidence:** Verified by `tests/test-hook.mjs` (Group J.4: parent `XDG_STATE_HOME=/tmp/my-app pytest` and `LOCALAPPDATA=/tmp/my-app npm test` allowed; governance-targeting commands, `AGY_TEST_PROFILE_DIR=...`, and restricted-child `XDG_STATE_HOME`/`LOCALAPPDATA` attempts denied).
9. **Root cause / related IDs:** Overly broad regex grouped OS-standard env vars (`XDG_STATE_HOME`, `LOCALAPPDATA`) with Antigravity-specific env vars.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-008`: Normal user project folders (`scoring/`, `evaluation/`, `benchmarks/`, `prompt_templates/`) trigger `[BENCHMARK MUTATION DETECTED]` `force_ask` with no opt-out | P2 | Closed

1. **Title, priority, status:** Normal user project folders (`scoring/`, `evaluation/`, `benchmarks/`, `prompt_templates/`) trigger `[BENCHMARK MUTATION DETECTED]` `force_ask` with no opt-out, P2, Closed.
2. **Contract provenance:** `docs/governance.md` documents benchmark-file confirmation as a safety guardrail for evaluations, not an undocumented permanent roadblock for everyday application source folders.
3. **Source evidence:** `scripts/execution-guard-hook.mjs` (`isBenchmarkGuardDisabled`, Sections 1 and 4 `force_ask` prompts), `docs/governance.md`.
4. **Trigger:** A developer building a normal application with `src/scoring/ranker.ts`, `evaluation/metrics.py`, `benchmarks/perf.js`, or `prompt_templates/welcome.md` edits or moves files in their repository.
5. **Expected / actual:** Fixed in Session 2: added `AGY_DISABLE_BENCHMARK_GUARD=1` opt-out for top-level non-restricted user sessions (ignored for restricted child sessions), updated both `force_ask` prompts to mention `Set AGY_DISABLE_BENCHMARK_GUARD=1 to disable this guard for non-evaluation repos.`, and documented it in `docs/governance.md`.
6. **Impact:** Developers in non-evaluation repos have an explicit opt-out while evaluation safety remains default-on and enforced for restricted children.
7. **Required remediation:** Completed in Session 2 (`scripts/execution-guard-hook.mjs`, `docs/governance.md`).
8. **Acceptance evidence:** Verified by `tests/test-hook.mjs` (Group J.5: default `force_ask` with hint, top-level opt-out allows `edit_file` and shell `rm`, restricted child stays `force_ask`).
9. **Root cause / related IDs:** Hardcoded evaluation-harness path heuristic lacked an opt-out toggle.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-009`: `zensical.toml` nav omits `INSTALLER-HARDENING.md` & `RTK-SUPPORT-MATRIX.md`, and docs assume a gitignored `scratch/` directory | P2 | Closed

1. **Title, priority, status:** `zensical.toml` nav omits `INSTALLER-HARDENING.md` & `RTK-SUPPORT-MATRIX.md`, and docs assume a gitignored `scratch/` directory, P2, Closed.
2. **Contract provenance:** `README.md` and `docs/index.md` promote both `INSTALLER-HARDENING.md` and `RTK-SUPPORT-MATRIX.md` as core public docs, and `--out` works with any safe workspace-relative `.md`/`.json`/`.txt` path.
3. **Source evidence:** `zensical.toml#L11-L21`, `README.md`, `docs/tools.md`.
4. **Trigger:** A developer browses the hosted Zensical docs sidebar for installer security or RTK config details, or copies `--out scratch/agy-squad/transcript-index.md` from `docs/tools.md` into their own repo.
5. **Expected / actual:** Fixed in Session 2: added `{ "Installer Hardening" = "INSTALLER-HARDENING.md" }` and `{ "RTK Support Matrix" = "RTK-SUPPORT-MATRIX.md" }` to `zensical.toml` `nav`; updated all `--out` examples in `README.md` and `docs/tools.md` to repo-neutral paths (`./transcript-export.md`, `./session.md`, `./outline.md`, `./step-42.md`, `./transcript-index.md`) with a clear note recommending adding `scratch/` to `.gitignore` or `.git/info/exclude` if used.
6. **Impact:** Core hardening and RTK docs appear in sidebar navigation and external users no longer get untracked companion-plugin `scratch/agy-squad/` directories.
7. **Required remediation:** Completed in Session 2 (`zensical.toml`, `README.md`, `docs/tools.md`).
8. **Acceptance evidence:** Verified both nav targets exist in `docs/` (`INSTALLER-HARDENING.md`, `RTK-SUPPORT-MATRIX.md`), confirmed zero hardcoded `scratch/agy-squad` paths in public docs, and passed `npm run verify:package`.
9. **Root cause / related IDs:** Docs nav and example paths drifted from internal repo conventions; mirrors `UX-SQ-007` in `Agy-Squad`.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-010`: Raw LaTeX math syntax in `rules/AGENTS.md` and `skills/context-governance/SKILL.md` renders as raw `$...$` noise | P2 | Closed

1. **Title, priority, status:** Raw LaTeX math syntax in `rules/AGENTS.md` and `skills/context-governance/SKILL.md` renders as raw `$...$` noise, P2, Closed.
2. **Contract provenance:** `docs/roadmap.md#L44` commits to keeping `rules/AGENTS.md` and `skills/context-governance/SKILL.md` concise and cleanly rendered in Antigravity prompts and GitHub Markdown.
3. **Source evidence:** `rules/AGENTS.md`, `skills/context-governance/SKILL.md`.
4. **Trigger:** Any developer inspects `rules/AGENTS.md` or `skills/context-governance/SKILL.md` on GitHub or inside Antigravity IDE, or any LLM ingests `rules/AGENTS.md` in its system prompt.
5. **Expected / actual:** Fixed in Session 2: replaced every inline `$...$` LaTeX fragment in `rules/AGENTS.md` and `skills/context-governance/SKILL.md` with clean plain ASCII/Markdown equivalents while preserving exact numeric thresholds and backoff formulas.
6. **Impact:** Cleaner rendering across Markdown viewers and fewer prompt tokens per turn.
7. **Required remediation:** Completed in Session 2 (`rules/AGENTS.md`, `skills/context-governance/SKILL.md`).
8. **Acceptance evidence:** Confirmed `0` `$` characters in both files via `grep -n '\$'`, plus `npm run preflight`, `npm test`, and `agy plugin validate --strict --json`.
9. **Root cause / related IDs:** MathJax/Zensical syntax was copied directly into plain-Markdown agent prompt files.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

#### `UX-ACS-011`: `agy-context --help` prints 200+ character wrapped flag walls without quick examples | P2 | Closed

1. **Title, priority, status:** `agy-context --help` prints 200+ character wrapped flag walls without quick examples, P2, Closed.
2. **Contract provenance:** CLI help is a developer's primary in-terminal discovery surface (`bin/agy-context.mjs`).
3. **Source evidence:** `bin/agy-context.mjs` (`printHelp`).
4. **Trigger:** A developer runs `agy-context --help` or `agy-context` in a standard 80-to-120 column terminal.
5. **Expected / actual:** Fixed in Session 2: reformatted `printHelp()` with compact `<= 95`-char summary lines, a 4-command `Examples:` section (`status`, `transcript health`, `transcript read --last-turns 3`, `transcript query "error" --summary`), and a pointer to subcommand `--help`.
6. **Impact:** Crisp, scannable in-terminal CLI discovery on standard terminal widths.
7. **Required remediation:** Completed in Session 2 (`bin/agy-context.mjs`).
8. **Acceptance evidence:** Verified by `tests/test-transcript.mjs` (Section 11: exit 0, `Examples:` present, max line length `<= 105` chars).
9. **Root cause / related IDs:** All flags were previously inlined into a single top-level help block; directly paired with `UX-ACS-012`.
10. **Closure:** Closed in Session 2 on `fix/ux-day-one-blockers` (PR #10).

### 5.2 P3 actionable advisory table

| ID | Wave/Session | Cat | Status | Source | Defect / Proposal | Disposition / Fix | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `UX-ACS-012` | Session 2 | SCRIPT | Closed | `bin/agy-context.mjs` (`printSubcommandHelp` + all 12 `--help` branches) | Every subcommand `--help` printed the identical top-level help wall instead of focused subcommand flags and examples. | Added `printSubcommandHelp(topic)` covering `transcript`, `read`, `query`, `step`, `health`, `list`, `export`, `access`, `status`, `setup`, `uninstall`, and `restore-backups` (plus all aliases) while preserving `assertCleanHelp` and `consumeTranscriptAccessGrant`. | Verified in `tests/test-transcript.mjs` (Section 11: all 14 subcommand `--help` topics exit 0, distinct from top-level help, `<= 105` cols, include specific flags and `Examples:`, and reject conflicting `--help` flags). |
| `UX-ACS-013` | Session 2 | SCRIPT | Closed | `scripts/install-register.mjs` (`runStatus`) | When `agy-context status` reported `NOT INSTALLED` or `PARTIAL INSTALLATION`, it printed no remediation command. | Added 1-line `Next step: run 'npx --package=agy-context-saver agy-context setup' (or 'agy-context setup') to install/repair.` below `Overall Status` in non-JSON mode while keeping `--json` pure JSON. | Verified in `tests/test-lifecycle-rollback.mjs` (Section 5: clean-profile `NOT INSTALLED`, `PARTIAL INSTALLATION`, and pure `--json` assertions). |

---

## 6. Cross-Plugin Interactions & Verification Plan

### 6.1 Cross-plugin summary (`Agy-Context-Saver` + `Agy-Squad`)

- **Standalone `Agy-Context-Saver`:** Fully viable and clean once `UX-ACS-001` through `UX-ACS-004` are remediated. Its docs properly present `Agy-Squad` as an optional companion.
- **Paired with `Agy-Squad`:**
  1. `Agy-Squad/mcp/briefs.mjs` currently contradicts `Agy-Context-Saver/rules/AGENTS.md#L43` by directing workers to inspect workspace files with `rtk read` (tracked in `Agy-Squad` review as `UX-SQ-006`).
  2. Both installers place shims in `~/.gemini/antigravity/bin/` and lack `PATH` onboarding (`UX-ACS-003` and `UX-SQ-005`); aligning their post-install `PATH` + IDE reload messages creates a seamless paired onboarding experience.
  3. Fixing `UX-ACS-001` (`rtk` local binary rewrite) and `UX-ACS-003` (`agy-context` shim fallback rewrite) directly unblocks `Agy-Squad` `/swarm` workers and `audit-<id>` integrity auditors on fresh machines.

### 6.2 Verification plan for PR #10 (stacked on PR #9)

1. Branch off `fix/v2.0.4-rtk-read-parity` (`8b5695c6aa75eb33ccbefc16fe0f128597db78bf`) and implement fixes for all 13 actionable findings (`UX-ACS-001` through `UX-ACS-013`).
2. Add targeted automated regression tests across `tests/test-hook.mjs`, `tests/test-output-governance.mjs`, `tests/test-transcript.mjs`, `tests/test-lifecycle-rollback.mjs`, and `tests/test-rtk-ledger-fresh-install.mjs`.
3. Run full release verification pipeline:
   - `npm run preflight`
   - `node scripts/install-register.mjs --check`
   - `npm test` (all 12 test suites passing)
   - `npm run verify:package`
   - `zensical build` (when available)
4. Re-verify every finding against the updated commits and update `docs/reviews/UX-day-one-blockers/ux-day-one-review-r1.md` before opening PR #10 targeting `fix/v2.0.4-rtk-read-parity`.

---

## 7. Overall disposition and finding closure table

### 7.1 Overall disposition

- **Coverage:** Complete across all material user-facing categories (`ARCH`, `DOC`, `SKILL`, `RUN`, `SVC`, `SCRIPT`, `TEST`, `DEP`); `MCP` and `DB` Not applicable.
- **Blocking findings:** None open (`UX-ACS-001` through `UX-ACS-013` all verified closed in Session 2).
- **Disposition:** Approve (`Content Verdict: PASS`).
- **Reason:** All 13 actionable launch UX blockers (`UX-ACS-001`..`UX-ACS-013`) are remediated with regression test coverage across all 5 suites, full 12/12 `npm test` pass, `npm run preflight` pass, `npm run verify:package` (`32` files, `docs/plans/**` and `docs/reviews/**` excluded), `agy plugin validate --strict --json` (`0` findings), clean public boundary, and zero prose em dashes. Only the external Antigravity host `PreToolUse` payload limitation (`UX-ACS-014`) remains deferred in Section 8.

### 7.2 Finding closure table (`1 ID = 1 Row`)

| ID | Category | Priority | Status | Summary | Fix Commit / Evidence |
| --- | --- | --- | --- | --- | --- |
| `UX-ACS-001` | RUN | P0 | Closed | Explicit `rtk ...` commands rewrite to local `rtkPrefix` when absent from `PATH`; managed `rtk`/`rtk.cmd` shim installed/cleaned safely | `scripts/execution-guard-hook.mjs`, `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`; `tests/test-hook.mjs` (J.1), `tests/test-lifecycle-rollback.mjs` (Sec 5) |
| `UX-ACS-002` | RUN | P1 | Closed | `--allow-degraded` mode without `rtk` allows native discovery & bounded `head/tail -n 150` while keeping `.system_generated/` & running task logs protected | `scripts/execution-guard-hook.mjs`; `tests/test-hook.mjs` (J.2), `tests/test-output-governance.mjs` (Group 2) |
| `UX-ACS-003` | SCRIPT | P1 | Closed | Added `PATH` detection & copy-paste POSIX/PowerShell snippets in `runInstall()`/`runStatus()`, bare `agy-context` hook shim/CLI fallback, and `PATH`+`npx` docs | `scripts/install-register.mjs`, `scripts/execution-guard-hook.mjs`, `README.md`, `docs/installation.md`; `tests/test-lifecycle-rollback.mjs` (Sec 5), `tests/test-hook.mjs` (J.3) |
| `UX-ACS-004` | SCRIPT | P1 | Closed | Removed silent global `git config --global core.safecrlf false` mutation from `ensureRtkConfigured()` (retained per-command rule in `rules/AGENTS.md`) | `scripts/provision-rtk.mjs`; `tests/test-rtk-ledger-fresh-install.mjs`, `tests/test-lifecycle-rollback.mjs` (Sec 5) |
| `UX-ACS-005` | DOC | P2 | Closed | Updated `docs/installation.md` uninstall section to lead with global `agy-context uninstall` and `npx` fallback before local-checkout commands | `docs/installation.md`; reconciled with `README.md` |
| `UX-ACS-006` | SCRIPT | P2 | Closed | Added post-install `Next steps:` reload/status block and Windows `node.cmd` wrapper parity (`installWindowsNodeCmdWrapper`) in `scripts/install-register.mjs` | `scripts/install-register.mjs`, `docs/installation.md`, `docs/INSTALLER-HARDENING.md`; `tests/test-lifecycle-rollback.mjs` (Sec 5) |
| `UX-ACS-007` | RUN | P2 | Closed | Scoped `XDG_STATE_HOME`/`LOCALAPPDATA` blocking in `isProtectedShellOrScriptOperation()` to restricted children and governance-targeting commands | `scripts/execution-guard-hook.mjs`; `tests/test-hook.mjs` (J.4) |
| `UX-ACS-008` | RUN | P2 | Closed | Added `AGY_DISABLE_BENCHMARK_GUARD=1` opt-out for top-level non-restricted sessions, prompt hint, and `docs/governance.md` docs | `scripts/execution-guard-hook.mjs`, `docs/governance.md`; `tests/test-hook.mjs` (J.5) |
| `UX-ACS-009` | DOC | P2 | Closed | Added `INSTALLER-HARDENING.md` & `RTK-SUPPORT-MATRIX.md` to `zensical.toml` `nav`; made `--out` doc examples repo-neutral with `scratch/` gitignore note | `zensical.toml`, `README.md`, `docs/tools.md` |
| `UX-ACS-010` | SKILL | P2 | Closed | Replaced all raw `$...$` LaTeX fragments in `rules/AGENTS.md` and `skills/context-governance/SKILL.md` with plain ASCII/Markdown | `rules/AGENTS.md`, `skills/context-governance/SKILL.md` (`0` `$` hits) |
| `UX-ACS-011` | SCRIPT | P2 | Closed | Reformatted top-level `printHelp()` (`<= 95` cols + 4 copy-paste examples + subcommand `--help` pointer) | `bin/agy-context.mjs`; `tests/test-transcript.mjs` (Sec 11) |
| `UX-ACS-012` | SCRIPT | P3 | Closed | Added `printSubcommandHelp(topic)` for all 12 subcommands and aliases while preserving `assertCleanHelp` and `consumeTranscriptAccessGrant` | `bin/agy-context.mjs`; `tests/test-transcript.mjs` (Sec 11) |
| `UX-ACS-013` | SCRIPT | P3 | Closed | Added 1-line `Next step: run 'npx --package=agy-context-saver agy-context setup'` hint on `NOT INSTALLED` / `PARTIAL INSTALLATION` while keeping `--json` pure | `scripts/install-register.mjs`; `tests/test-lifecycle-rollback.mjs` (Sec 5) |

---

## 8. Post-Remediation Residuals & Deferred Dispositions

| ID | Wave/Session | Cat | Status | Source | Defect / Proposal | Disposition / Fix | Verification & Bundle SHA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `UX-ACS-014` | Session 1 | ARCH | Deferred / Won't Fix | `scripts/execution-guard-hook.mjs#L5034-L5139` | Read-only subagents whose host toolset omits `run_command` still receive `via run_command` redirect hints on `read_file`/`grep_search`/`find_by_name`/`list_dir` denials. | Deferred on external Antigravity host limitation: `PreToolUse` stdin JSON payloads do not expose the active session's available tool list, so the hook cannot distinguish subagents lacking `run_command`. Revisit if Antigravity adds tool-capability metadata to `PreToolUse` payloads. | Source-derived inspection of `scripts/execution-guard-hook.mjs#L4544-L4552` |
