# Agy-Context-Saver v2.0.4 Launch UX & Regression Review (r2)

**Governing Standard:** Agy-Squad PR Review Standard 1.4.0
**Review type:** Independent Round-2 Launch UX & Regression Review (PR #10 Verification + Fresh Adversarial Edge-Case Audit)
**Review date:** 2026-11-19
**Reviewer:** Independent Senior DX & Plugin UX Reviewer (Read-Only Subagent)
**Standard version:** 1.4.0

Content Verdict: PASS

---

## 1. Review metadata, Session Provenance, and evidence limits

### 1.1 Target

| Field | Value |
| --- | --- |
| Repository | `paragon-ux/Agy-Context-Saver` |
| Target | PR #11 (`fix/ux-day-one-r2`), stacked on PR #10 (`fix/ux-day-one-blockers`), v2.0.4 npm release candidate |
| Comparison base | `fix/ux-day-one-blockers` (`833e20df07a4c299bde302d4f8ad811a1b85c254`) (PR #10 base: `fix/v2.0.4-rtk-read-parity` @ `8b5695c6aa75eb33ccbefc16fe0f128597db78bf`) |
| Head / tree | `fix/ux-day-one-r2` (remediated in Session 4) |
| Working-tree state | All 5 actionable Round-2 findings (`UX-ACS-R2-001`..`UX-ACS-R2-005`) remediated with regression tests and verified cleanly in Session 4; 3 deferred/informational items (`UX-ACS-014`, `UX-ACS-R2-006`, `UX-ACS-R2-007`) retained in Section 8 |
| CI revision | Session 4 executed full local release verification gates on `fix/ux-day-one-r2`: `npm test` (12/12 suites passing), `npm run preflight`, `npm run verify:package` (32 files, `docs/plans/**` & `docs/reviews/**` excluded), `agy plugin validate --strict --json` (0 findings), public-boundary grep (0 hits), and prose `U+2014` em-dash check (0 hits) |
| Prior review | `docs/reviews/UX-day-one-blockers/ux-day-one-review-r1.md` (Sessions 1 and 2) |

### 1.2 Session Provenance

| Session # | Operator Conversation ID | Parent Session | Date | Base..Head + Working-Tree State | Skill / Topology Invoked |
| --- | --- | --- | --- | --- | --- |
| 1 | `04291507-36ae-4728-a17a-149dbb4714f7` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `fix/v2.0.4-rtk-read-parity` @ `8b5695c6aa75eb33ccbefc16fe0f128597db78bf` (read-only) | Read-only Launch UX Reviewer subagent (r1) |
| 2 | `e835beb8-0ad2-44fb-a713-108519c18ec8` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `8b5695c6aa75eb33ccbefc16fe0f128597db78bf..833e20df07a4c299bde302d4f8ad811a1b85c254` (remediated) | Launch UX Remediation Subagent (PR #10) |
| 3 | `ef8f5c58-2080-4500-bec2-522bb347e482` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `8b5695c6aa75eb33ccbefc16fe0f128597db78bf..833e20df07a4c299bde302d4f8ad811a1b85c254` (read-only) | Independent Round-2 Launch UX & Regression Reviewer subagent (r2) |
| 4 | `345a487d-1eb2-4e0a-af87-25bf3c9c8883` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `833e20df07a4c299bde302d4f8ad811a1b85c254..fix/ux-day-one-r2` (remediated & verified) | Round-2 Launch UX Remediation Subagent (PR #11) |

### 1.3 Evidence available

- Full line-by-line source inspection on disk at commit `833e20df07a4c299bde302d4f8ad811a1b85c254`:
  - Core runtime & CLI: `scripts/execution-guard-hook.mjs` (all 5,496 lines), `scripts/install-register.mjs` (all 1,515 lines), `scripts/provision-rtk.mjs` (all 306 lines), `scripts/state-dir.mjs`, `scripts/release-preflight.mjs`, `bin/agy-context.mjs`, `install.sh`, `install.ps1`, `hooks.json`, `plugin.json`, `package.json`.
  - Rules, skills, and public docs: `rules/AGENTS.md`, `skills/context-governance/SKILL.md`, `README.md`, `SECURITY.md`, `CHANGELOG.md`, `zensical.toml`, `docs/index.md`, `docs/installation.md`, `docs/tools.md`, `docs/governance.md`, `docs/architecture.md`, `docs/INSTALLER-HARDENING.md`, `docs/RTK-SUPPORT-MATRIX.md`, `docs/publishing.md`, `docs/roadmap.md`.
  - Automated regression suites: `tests/test-hook.mjs` (Group I and Group J), `tests/test-output-governance.mjs` (full file), `tests/test-transcript.mjs` (Section 11), `tests/test-lifecycle-rollback.mjs` (Sections 4 and 5), `tests/test-rtk-ledger-fresh-install.mjs` (full file), `tests/verify-package.mjs` (full file).
  - Prior review record: `docs/reviews/UX-day-one-blockers/ux-day-one-review-r1.md`.

### 1.4 Evidence limits

- Session 3 operated strictly read-only (`EnableWriteTools: false`, no shell execution); all findings below are proven by direct source inspection of exact code paths and test assertions on disk.
- Physical Windows ARM64, Windows PowerShell (with spaces in `%USERPROFILE%`), and macOS Antigravity Desktop IDE GUI sessions were not executed live; Windows PowerShell command-parsing rules and `npx` copy-upgrade flows were traced directly from `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, and `scripts/execution-guard-hook.mjs`.
- Antigravity host `PreToolUse` payloads still do not disclose active session tool capabilities (preserved in Section 8 as `UX-ACS-014`).

---

## 2. File/artifact-to-category inventory and coverage matrix

| Artifact | Role | Primary category | Cross-references | Coverage |
| --- | --- | --- | --- | --- |
| `scripts/execution-guard-hook.mjs` | `PreToolUse` hook: local `rtk` rewrite, degraded mode, bare `agy-context` rewrite, `XDG_STATE_HOME`/`LOCALAPPDATA` scoping, benchmark opt-out | RUN | SCRIPT, SKILL, DOC | Complete |
| `scripts/install-register.mjs` | Cross-platform setup, managed `rtk` shim, `PATH` onboarding, Windows `node.cmd` parity, uninstall, status | SCRIPT | RUN, DOC, TEST | Complete |
| `scripts/provision-rtk.mjs` | RTK >= 1.1.0 resolution (`PATH` vs local), SHA-256 download, `config.toml` setup (zero global git mutation) | SCRIPT | RUN, DOC, TEST | Complete |
| `bin/agy-context.mjs` | CLI top-level help and focused per-subcommand `--help` with grant/conflict guards | SCRIPT | SVC, TEST | Complete |
| `install.sh`, `install.ps1` | POSIX and Windows installer wrappers (`node.cmd` interaction with `install-register.mjs`) | SCRIPT | DOC | Complete |
| `rules/AGENTS.md`, `skills/context-governance/SKILL.md` | Auto-loaded agent rules and context-governance skill | SKILL | RUN, DOC | Complete |
| `README.md`, `SECURITY.md`, `CHANGELOG.md`, `zensical.toml`, `docs/*.md` | Public landing page, docs nav, security policy, and user reference | DOC | SCRIPT, RUN, DEP | Complete |
| `plugin.json`, `package.json`, `hooks.json`, `scripts/release-preflight.mjs` | Manifests, `suggestedPrompts`, packaging whitelist, release preflight | DEP | DOC, TEST | Complete |
| `tests/test-hook.mjs`, `tests/test-output-governance.mjs`, `tests/test-transcript.mjs`, `tests/test-lifecycle-rollback.mjs`, `tests/test-rtk-ledger-fresh-install.mjs`, `tests/verify-package.mjs` | Automated regression suites for PR #10 and package boundaries | TEST | RUN, SCRIPT | Complete |

| Category | Scope covered | Coverage | Verdict |
| --- | --- | --- | --- |
| ARCH | Architectural boundary across hook, CLI, RTK, and companion `Agy-Squad` | Complete | No findings within reviewed scope |
| DOC | `README.md`, `SECURITY.md`, `zensical.toml`, `docs/*.md` | Complete | Pass (`UX-ACS-R2-005` closed in Session 4) |
| SKILL | `rules/AGENTS.md`, `skills/context-governance/SKILL.md` | Complete | Pass (`UX-ACS-R2-004` closed in Session 4) |
| MCP | Legacy v1.x MCP retirement contract (no active MCP server in v2.0.4) | Complete | Not applicable |
| RUN | `scripts/execution-guard-hook.mjs` local `rtk`, degraded mode, bare `agy-context`, env scoping, benchmark guard | Complete | Pass (`UX-ACS-R2-002`, `UX-ACS-R2-003` closed in Session 4) |
| SVC | Transcript streaming, lineage, access control, single-use grants (`bin/agy-context.mjs`, `scripts/execution-guard-hook.mjs`) | Complete | No findings within reviewed scope |
| DB | Filesystem JSON/JSONL state only (no relational/embedded DB) | Complete | Not applicable |
| SCRIPT | `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, `bin/agy-context.mjs`, `install.sh`, `install.ps1` | Complete | Pass (`UX-ACS-R2-001` closed in Session 4) |
| TEST | Regression test assertions across all PR #10 & PR #11 suites + `verify-package.mjs` | Complete | Pass (regressions added & verified for `UX-ACS-R2-001`..`UX-ACS-R2-003` in Session 4) |
| DEP | `package.json`, `plugin.json`, `hooks.json`, `scripts/release-preflight.mjs` | Complete | No findings within reviewed scope |

---

## 3. Round-1 Closure Verification & Adversarial Trace

### 3.1 Independent verification of Round-1 (`UX-ACS-001`..`UX-ACS-013`)

| Round-1 ID | Original area | Independent source verification at `833e20df` | Round-2 status |
| --- | --- | --- | --- |
| `UX-ACS-001` | Local `rtkPrefix` rewrite + managed `rtk` shim | Hook `postProcessSegmentText` (`scripts/execution-guard-hook.mjs#L4324-L4344`) and Group J.1 tests (`tests/test-hook.mjs#L2150-L2192`) work cleanly for fresh installs; unmanaged user `rtk` preservation works (`scripts/install-register.mjs#L702-L732`, `L1206-L1216`). **However**, adding `~/.gemini/antigravity/bin` to `PATH` causes subsequent `npx` setup/upgrade runs to delete `pluginDest/bin/rtk` and leave a dangling managed shim. | Regression introduced (`UX-ACS-R2-001`) |
| `UX-ACS-002` | `--allow-degraded` without RTK | POSIX degraded discovery (`grep_search`, `find_by_name`, `list_dir`) and bounded `head -n 150`/`tail -n 150` work while keeping `.system_generated/`, `RUNNING`/`UNKNOWN` logs, `+N` offsets, and multi-operand reads denied (`scripts/execution-guard-hook.mjs#L3837-L3899`, `L4986-L5039`, `L5278-L5280`). **However**, Windows ARM64 (the primary `--allow-degraded` platform) remains deadlocked on completed task logs and receives POSIX-only `grep -rnE` hints. | Incomplete on Windows ARM64 (`UX-ACS-R2-002`) |
| `UX-ACS-003` | `PATH` onboarding + bare `agy-context` rewrite | `isDirOnPath`, `formatPathOnboardingLines`, `runInstall`/`runStatus`, docs, and POSIX/no-space hook rewrites work cleanly (`scripts/install-register.mjs#L105-L173`, `scripts/execution-guard-hook.mjs#L829-L852`, `L4969-L4980`). **However**, on Windows with spaces in `%USERPROFILE%`, rewriting bare `agy-context` to a leading double-quoted `.cmd` path causes a PowerShell syntax error. | Edge-case defect on Windows space paths (`UX-ACS-R2-003`) |
| `UX-ACS-004` | Zero global `~/.gitconfig` mutation | Confirmed zero `git config` calls anywhere in `scripts/provision-rtk.mjs` or `scripts/install-register.mjs`; per-command rule retained in `rules/AGENTS.md#L59`; verified by `tests/test-rtk-ledger-fresh-install.mjs#L42-L60` and `tests/test-lifecycle-rollback.mjs#L249-L308`. | Verified Closed |
| `UX-ACS-005` | Global uninstall commands in `docs/installation.md` | Confirmed `docs/installation.md#L124-L145` leads with `agy-context uninstall`, `--restore-backups`, and `npx` fallback ahead of local-checkout commands. | Verified Closed |
| `UX-ACS-006` | Post-install reload cue + Windows `node.cmd` parity | Confirmed `Next steps:` block (`scripts/install-register.mjs#L1091-L1094`) and `installWindowsNodeCmdWrapper` (`L601-L636`, `L1079-L1081`, `L1218-L1236`) matching `install.ps1#L43-L90` safely without backup clobbering; verified in `tests/test-lifecycle-rollback.mjs#L310-L314`, `L407-L423`. | Verified Closed |
| `UX-ACS-007` | Scoped `XDG_STATE_HOME` / `LOCALAPPDATA` | Confirmed `scripts/execution-guard-hook.mjs#L253-L267` keeps Antigravity env vars unconditionally blocked while allowing ordinary parent tests and blocking restricted children (`L4912`, `L5466`) and governance targets; verified in Group J.4 (`tests/test-hook.mjs#L2313-L2370`). Residual `SECURITY.md#L27` doc drift tracked under `UX-ACS-R2-005`. | Verified Closed (minor doc sync in `UX-ACS-R2-005`) |
| `UX-ACS-008` | `AGY_DISABLE_BENCHMARK_GUARD=1` opt-out | Confirmed `isBenchmarkGuardDisabled` (`scripts/execution-guard-hook.mjs#L414-L419`), both `force_ask` prompt hints (`L4790`, `L5477`), `docs/governance.md#L49`, and Group J.5 tests (`tests/test-hook.mjs#L2371-L2412`) enforce restricted-child non-bypassability. | Verified Closed |
| `UX-ACS-009` | `zensical.toml` nav + repo-neutral `--out` paths | Confirmed `zensical.toml#L17-L18` includes `INSTALLER-HARDENING.md` and `RTK-SUPPORT-MATRIX.md`; confirmed `README.md#L71-L75` and `docs/tools.md#L75`, `L84`, `L123`, `L151`, `L186`, `L190` use repo-neutral paths with a `scratch/` gitignore note. | Verified Closed |
| `UX-ACS-010` | Zero raw `$...$` LaTeX in rules and skill | Confirmed 0 `$` characters across all 69 lines of `rules/AGENTS.md` and all 114 lines of `skills/context-governance/SKILL.md`. | Verified Closed |
| `UX-ACS-011` | Top-level `agy-context --help` ergonomics | Confirmed `bin/agy-context.mjs#L53-L84` max line length is 93 chars with 4 copy-paste examples and subcommand `--help` pointer; verified in `tests/test-transcript.mjs#L2848-L2863`. | Verified Closed |
| `UX-ACS-012` | Per-subcommand `--help` coverage | Confirmed `printSubcommandHelp` (`bin/agy-context.mjs#L86-L329`) and all 12 `--help` branches preserve `assertCleanHelp` and `consumeTranscriptAccessGrant`; verified across all 14 topics + conflict checks in `tests/test-transcript.mjs#L2865-L2901`. | Verified Closed |
| `UX-ACS-013` | `status` setup hint on `NOT INSTALLED` / `PARTIAL` | Confirmed `scripts/install-register.mjs#L1391-L1393` prints the 1-line setup hint in non-JSON mode while keeping `--json` pure JSON; verified in `tests/test-lifecycle-rollback.mjs#L262-L277`, `L356-L364`. | Verified Closed |

### 3.2 Adversarial edge-case trace (new failure paths)

| User journey / adversarial path | Promised contract | Actual code path at `833e20df` | Result |
| --- | --- | --- | --- |
| Fresh `npx` user adds `~/.gemini/antigravity/bin` to `PATH` (per installer `[NEXT STEP]`), then later runs `npx --package=agy-context-saver agy-context setup` to repair or upgrade | Non-destructive idempotent upgrade preserving local RTK | `findExistingRtk()` hits managed shim on `PATH` -> returns `isLocal: false` -> `runInstall()` skips `preservedPluginRtk` (`L942`) -> `rm(pluginDest)` deletes `pluginDest/bin/rtk` (`L958`) -> leaves dangling shim + exits 0 | Mismatch (`UX-ACS-R2-001`, P1) |
| Windows ARM64 user installs with `--allow-degraded` (no RTK, no POSIX `head`/`tail`/`grep`) and inspects a completed task log or hits an unbounded `read_file` denial | `docs/RTK-SUPPORT-MATRIX.md#L11`: working hook-only governance on `win32-arm64` | Section 2b (`L5162-L5175`) denies bounded `read_file(<=150L)` on completed task logs and directs to POSIX `tail -n 150`; `parseDegradedBoundedHeadTailCommand` rejects PowerShell `Get-Content`; Section 2e (`L5202`) recommends nonexistent POSIX `grep -rnE` instead of allowed `grep_search` | Mismatch (`UX-ACS-R2-002`, P1) |
| Windows user with spaces in `%USERPROFILE%` (e.g. `C:\Users\Jane Doe`) runs `suggestedPrompts` in Antigravity Desktop IDE before updating `PATH` | `README.md`, `plugin.json`, `docs/installation.md#L37`: bare `agy-context` works out of the box inside Antigravity | `resolveInstalledAgyContextCommand` (`L841-L842`) emits `"C:\Users\Jane Doe\...\agy-context.cmd" transcript health` -> PowerShell parser rejects leading quoted executable without `&` | Mismatch (`UX-ACS-R2-003`, P2) |
| Public boundary hygiene check across shipped rules, skills, and docs | Strict internal vs. public ledger boundary; zero prose `U+2014` em dashes | Zero prose `U+2014` em dashes and zero `LEDGER.md`/`L#` leaks in public docs/rules/skills; 1 opaque internal requirement tag `ACS-HOOK-09` remains in `skills/context-governance/SKILL.md#L24`, and `SECURITY.md#L27` lags `UX-ACS-007` | Minor drift (`UX-ACS-R2-004`, `UX-ACS-R2-005`, P3) |

---

## 4. Category reviews

### 4.1 `ARCH`: Architecture and contracts
- **Scope:** Separation of concerns across `PreToolUse` hook, `agy-context` CLI, RTK >= 1.1.0, and companion `Agy-Squad`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope (host `PreToolUse` toolset-visibility constraint remains tracked in Section 8 as `UX-ACS-014`).
- **Verification:** Source inspection of `scripts/execution-guard-hook.mjs`, `scripts/install-register.mjs`, `docs/architecture.md`, and `docs/roadmap.md`.
- **Category Verdict:** No findings within reviewed scope.

### 4.2 `DOC`: Documentation and change records
- **Scope:** `README.md`, `SECURITY.md`, `CHANGELOG.md`, `zensical.toml`, `docs/index.md`, `docs/installation.md`, `docs/tools.md`, `docs/governance.md`, `docs/architecture.md`, `docs/INSTALLER-HARDENING.md`, `docs/RTK-SUPPORT-MATRIX.md`, `docs/publishing.md`, `docs/roadmap.md`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** `UX-ACS-R2-005` (Closed in Session 4) in `SECURITY.md#L27`.
- **Verification:** Verified zero prose `U+2014` em dashes across all public docs, verified `zensical.toml` navigation entries exist on disk, verified `docs/installation.md` and `docs/tools.md` `--out` / uninstall updates, and aligned `SECURITY.md#L27` with `scripts/execution-guard-hook.mjs#L241-L267`.
- **Category Verdict:** Pass (all findings closed in Session 4).

### 4.3 `SKILL`: Skills and agent instructions
- **Scope:** `rules/AGENTS.md` and `skills/context-governance/SKILL.md`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** `UX-ACS-R2-004` (Closed in Session 4) in `skills/context-governance/SKILL.md#L24`.
- **Verification:** Confirmed 0 `$` LaTeX fragments, 0 prose `U+2014` em dashes, and 0 opaque internal tags (`ACS-HOOK-*`, `LEDGER.md`, `L#`) across both shipped files; `agy plugin validate --strict --json` returned 0 findings.
- **Category Verdict:** Pass (all findings closed in Session 4).

### 4.4 `MCP`: MCP schemas and public API
- **Scope:** Retired v1.x MCP surface and cleanup sweep in `scripts/install-register.mjs`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed `mcp/` and `mcp_config.json` remain absent and denylisted in `tests/verify-package.mjs#L41-L44` and `scripts/release-preflight.mjs#L142-L147`.
- **Category Verdict:** Not applicable (no active MCP server shipped in v2.0.4).

### 4.5 `RUN`: Core runtime, parsing, and validation
- **Scope:** `scripts/execution-guard-hook.mjs` (local `rtkPrefix` rewrites, degraded mode, bare `agy-context` shim fallback, `XDG_STATE_HOME`/`LOCALAPPDATA` scoping, benchmark opt-out, restricted-child non-bypassability).
- **Coverage:** Complete.
- **P1 (high priority):** `UX-ACS-R2-002` (Closed in Session 4).
- **P2 (medium priority):** `UX-ACS-R2-003` (Closed in Session 4).
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Session 4 remediated degraded completed-task-log bounded `read_file` safe harbor and `grep_search` discovery guidance (`scripts/execution-guard-hook.mjs#L5047-L5050`, `L5167-L5232`) plus `win32` `node "<pluginCli>"` resolution (`L829-L864`), verified by `tests/test-output-governance.mjs` and `tests/test-hook.mjs`.
- **Category Verdict:** Pass (all findings closed in Session 4).

### 4.6 `SVC`: Services, orchestration, and audit semantics
- **Scope:** Transcript streaming, lineage parsing, 5-tier access precedence, and single-use capability grants (`bin/agy-context.mjs`, `scripts/execution-guard-hook.mjs#L1947-L3118`).
- **Coverage:** Complete across PR #10 interaction points.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed `bin/agy-context.mjs` `--help` handlers invoke `consumeTranscriptAccessGrant` identically on `read`/`query`/`step`/`export` and preserve `assertCleanHelp`, and confirmed restricted children cannot bypass `XDG_STATE_HOME`, `LOCALAPPDATA`, or `AGY_DISABLE_BENCHMARK_GUARD=1`.
- **Category Verdict:** No findings within reviewed scope.

### 4.7 `DB`: Database, migrations, replay, and concurrency
- **Scope:** Filesystem JSON/JSONL state only (`scripts/state-dir.mjs`, `scripts/execution-guard-hook.mjs#L107-L190`).
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed filesystem-only state persistence.
- **Category Verdict:** Not applicable.

### 4.8 `SCRIPT`: Scripts, evaluation, and developer tooling
- **Scope:** `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, `bin/agy-context.mjs`, `install.sh`, `install.ps1`.
- **Coverage:** Complete.
- **P1 (high priority):** `UX-ACS-R2-001` (Closed in Session 4).
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Session 4 remediated `scanPathForRtk()` / `findExistingRtk()` managed-shim detection (`scripts/provision-rtk.mjs#L162-L263`), unconditional `preservedPluginRtk` preservation (`scripts/install-register.mjs#L954-L1016`), and stale/dangling managed-shim cleanup (`scripts/install-register.mjs#L667-L711`), verified by `tests/test-lifecycle-rollback.mjs` and `tests/test-rtk-ledger-fresh-install.mjs`.
- **Category Verdict:** Pass (all findings closed in Session 4).

### 4.9 `TEST`: Tests and CI
- **Scope:** Regression tests across `tests/test-hook.mjs`, `tests/test-output-governance.mjs`, `tests/test-transcript.mjs`, `tests/test-lifecycle-rollback.mjs`, `tests/test-rtk-ledger-fresh-install.mjs`, plus `tests/verify-package.mjs` and full `npm test` (12/12).
- **Coverage:** Complete.
- **P1 (high priority):** Coverage gaps for `UX-ACS-R2-001` and `UX-ACS-R2-002` closed in Session 4.
- **P2 (medium priority):** Coverage gap for `UX-ACS-R2-003` closed in Session 4.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Added and passed on-`PATH` copy-mode upgrade + stale-managed-shim cleanup + `win32` managed-shim detection regressions (`tests/test-lifecycle-rollback.mjs#L356-L473`, `tests/test-rtk-ledger-fresh-install.mjs#L194-L219`), degraded completed-task-log bounded `read_file` + `grep_search` regressions (`tests/test-output-governance.mjs#L588-L639`, `tests/test-hook.mjs#L2220-L2228`), and spaced `Jane Doe Profile` bare `agy-context` rewrite/execution regressions (`tests/test-hook.mjs#L2275-L2398`); all 12/12 suites passed.
- **Category Verdict:** Pass (all coverage gaps closed in Session 4).

### 4.10 `DEP`: Dependencies, packaging, and configuration
- **Scope:** `package.json`, `plugin.json`, `hooks.json`, `scripts/release-preflight.mjs`, `tests/verify-package.mjs`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Verified zero runtime npm dependencies, `docs/plans/**` and `docs/reviews/**` exclusions in `package.json#L43-L62`, `plugin.json` metadata parity (`2.0.4`), and `tests/verify-package.mjs` whitelist checks.
- **Category Verdict:** No findings within reviewed scope.

---

## 5. Findings

### 5.1 P0/P1/P2 finding records

#### `UX-ACS-R2-001`: Managed `rtk` shim on `PATH` causes `npx` re-installs and upgrades to delete `pluginDest/bin/rtk` and leave a broken dangling shim | P1 | Closed

1. **Title, priority, status:** Managed `rtk` shim on `PATH` causes `npx` re-installs and upgrades to delete `pluginDest/bin/rtk` and leave a broken dangling shim, P1, Closed (Session 4).
2. **Contract provenance:** `README.md#L25`, `docs/installation.md#L27-L31`, `docs/roadmap.md#L55`, and `docs/INSTALLER-HARDENING.md#L11` promise idempotent upgrades and drift repair via `npx --package=agy-context-saver agy-context setup`, while `scripts/install-register.mjs#L152-L173` explicitly directs users to add `~/.gemini/antigravity/bin` to `PATH`.
3. **Source evidence:** `scripts/install-register.mjs#L152-L173`, `scripts/install-register.mjs#L668-L738`, `scripts/install-register.mjs#L885-L888`, `scripts/install-register.mjs#L936-L994`, `scripts/provision-rtk.mjs#L119-L153`, and `tests/test-lifecycle-rollback.mjs#L299-L365`.
4. **Trigger:** A developer without a pre-installed system `rtk` runs `npx --package=agy-context-saver agy-context setup` (which downloads `rtk` into `pluginDest/bin/rtk[.exe]` and installs the managed `~/.gemini/antigravity/bin/rtk[.cmd]` shim), then follows the installer's `[NEXT STEP]` advice to add `~/.gemini/antigravity/bin` to `PATH` (prepending it per `L168`). Later, the developer re-runs `npx --package=agy-context-saver agy-context setup` (to repair or upgrade to a new npm release such as v2.0.5).
5. **Expected / actual:** Expected: re-running `npx` setup preserves `pluginDest/bin/rtk[.exe]`, keeps the managed shim working, and leaves `agy-context status` reporting `HEALTHY & ACTIVE`. Actual:
   - `detectExistingInstallation()` (`L816`) calls `findExistingRtk()` (`scripts/provision-rtk.mjs#L128-L132`), which runs `rtk --version` on `PATH` first. Because `~/.gemini/antigravity/bin/rtk[.cmd]` is now on `PATH` and execs `pluginDest/bin/rtk`, `findExistingRtk()` returns `{ path: "rtk", version: "rtk 1.1.0", isLocal: false }`.
   - `ensureRtkInstalled({ existingRtk })` (`L887`) accepts `isLocal: false` and skips downloading `rtk` into `_npx/.../bin/`.
   - When `runInstall()` replaces `pluginDest` (`L938-L961`, because `isTempOrNpx` is true and `!installedSource`), line `942` gates `preservedPluginRtk` strictly on `if (rtkResult?.isLocal && rtkResult.path && !pluginLst.isSymbolicLink())`. Since `rtkResult.isLocal` is `false`, `preservedPluginRtk` stays `null`.
   - Line `958` executes `fsPromises.rm(pluginDest, { recursive: true, force: true })`, permanently deleting `pluginDest/bin/rtk[.exe]`.
   - Line `965` copies the new `_npx` package (which excludes `bin/rtk`), line `981` restores nothing, and line `1076` skips `installManagedRtkShim` because `verifyLocalRtkBinary(pluginDest/bin/rtk)` is now null.
   - `runInstall()` exits 0 printing `Installation synchronized & up-to-date`, leaving `~/.gemini/antigravity/bin/rtk[.cmd]` as a broken dangling shim (`RTK Command Optimizer: MISSING`, `Overall Status: PARTIAL INSTALLATION`) that also shadows any later system `rtk` installation on POSIX `PATH`.
6. **Impact:** Every `npx` user who follows the Day-1 `PATH` onboarding instructions will silently destroy their RTK binary on their very first upgrade or repair run across Linux, macOS, and Windows.
7. **Required remediation:**
   - In `scripts/install-register.mjs#L936-L954`, unconditionally inspect `pluginDest/bin/{rtk,rtk.exe,rtk.cmd}` (whenever `!pluginLst.isSymbolicLink()`) via `verifyLocalRtkBinary()` and preserve the binary into `preservedPluginRtk` regardless of `rtkResult?.isLocal`, restoring it after `fsPromises.cp()` at `L981-L994`.
   - In `scripts/provision-rtk.mjs` (`findExistingRtk`) or `scripts/install-register.mjs`, recognize when `rtk` on `PATH` resolves to our own managed shim in `~/.gemini/antigravity/bin/rtk[.cmd]` (`agy-context-saver-managed`): treat it as local (returning the underlying `pluginDest/bin/rtk[.exe]` with `isLocal: true` if valid, rather than `{ path: "rtk", isLocal: false }`), and remove any stale/dangling managed `rtk` shim in `installManagedRtkShim()` if no valid local binary exists (for example, when transitioning to a system `rtk` or `--allow-degraded`).
   - Add an end-to-end regression test in `tests/test-lifecycle-rollback.mjs` Section 5 executing a second copy-mode `runInstall({ forceCopyFallback: true })` with `uxBinDir` on `PATH` (`onPathEnv`) and asserting `pluginDest/bin/rtk[.cmd]` exists, executing the managed shim exits 0, and `status --json` reports `isComplete === true`.
8. **Acceptance evidence:** Passing `tests/test-lifecycle-rollback.mjs` (including the new on-`PATH` copy-mode re-install/upgrade test and stale-managed-shim cleanup assertion) plus full `npm test` (12/12).
9. **Root cause / related IDs:** Newly introduced interaction regression between `UX-ACS-001` (managed `rtk` shim in `antigravityBinDir`) and `UX-ACS-003` (`PATH` onboarding), where `findExistingRtk()` misclassified our own managed shim on `PATH` as an external system `rtk` (`isLocal: false`).
10. **Closure:** Closed in Session 4 (`fix/ux-day-one-r2`): `scripts/provision-rtk.mjs#L162-L263` (`scanPathForRtk` + `findExistingRtk`) detects managed `agy-context-saver-managed` shims in `~/.gemini/antigravity/bin` and resolves the local `pluginDest/bin/rtk[.exe]` with `isLocal: true` (or falls back to an external `PATH` `rtk` when the local binary is absent); `scripts/install-register.mjs#L954-L1016` unconditionally preserves `pluginDest/bin/{rtk,rtk.exe,rtk.cmd}` across copy replacements regardless of `rtkResult?.isLocal`; `scripts/install-register.mjs#L667-L711` removes stale/dangling managed shims when no valid local binary exists while preserving unmanaged user `rtk` binaries; verified by `tests/test-lifecycle-rollback.mjs#L356-L473` and `tests/test-rtk-ledger-fresh-install.mjs#L194-L219`.

#### `UX-ACS-R2-002`: Windows ARM64 `--allow-degraded` mode remains deadlocked on completed task logs and directs `read_file` denials to nonexistent POSIX `grep` | P1 | Closed

1. **Title, priority, status:** Windows ARM64 `--allow-degraded` mode remains deadlocked on completed task logs and directs `read_file` denials to nonexistent POSIX `grep`, P1, Closed (Session 4).
2. **Contract provenance:** `docs/RTK-SUPPORT-MATRIX.md#L11` and `docs/RTK-SUPPORT-MATRIX.md#L21` explicitly specify `--allow-degraded` as the supported hook-only mode for `win32-arm64` (unsupported for RTK auto-provisioning) and offline environments.
3. **Source evidence:** `scripts/execution-guard-hook.mjs#L3837-L3843` (`parseDegradedBoundedHeadTailCommand`), `scripts/execution-guard-hook.mjs#L5155-L5175` (Section 2b completed task log denial), `scripts/execution-guard-hook.mjs#L5198-L5204` (`getDiscoveryGuidance`), `scripts/execution-guard-hook.mjs#L5278-L5280` (degraded `grep_search` pass-through), and `tests/test-output-governance.mjs#L588-L595`.
4. **Trigger:** A Windows ARM64 developer installs with `agy-context setup --allow-degraded` (no `rtk`, no `rg`, and no POSIX `head`/`tail`/`grep` on PowerShell/`cmd.exe`), runs a background build/test command that completes, and attempts to read `.system_generated/tasks/task-X.log` or hits an unbounded `read_file` denial on a workspace source file.
5. **Expected / actual:** Expected: degraded mode provides working, bounded inspection on Windows ARM64 without relying on missing RTK or POSIX-only binaries. Actual:
   - In Section 2b (`L5162-L5175`), even when `state === "COMPLETED"` and `!hasRtkForTask`, bounded `read_file(StartLine=1, EndLine=150)` is unconditionally denied and instructs the agent to run `'tail -n 150 <path>' (or 'head -n 150 <path>') via run_command`. On Windows PowerShell/`cmd.exe`, neither `tail` nor `head` exists natively, while PowerShell `Get-Content -Tail 150` / `-TotalCount 150` is rejected by `parseDegradedBoundedHeadTailCommand` (`L3842`), leaving completed task log inspection deadlocked on Windows ARM64.
   - In Section 2e (`L5198-L5204`), when `!rtk && !rgAvailable`, `read_file` denials instruct the Windows ARM64 agent to run `'grep -rnE' via run_command` (which fails on PowerShell/`cmd.exe`) instead of recommending native `'grep_search'`, which Section 2f (`L5278-L5280`) explicitly allows in degraded mode on every OS.
6. **Impact:** Windows ARM64 users (the primary documented audience for `--allow-degraded`) still hit tool deadlocks on completed background task logs and broken shell suggestions on every unbounded `read_file` denial.
7. **Required remediation:**
   - In `scripts/execution-guard-hook.mjs#L5162-L5175` (Section 2b), mirror Section 2a (`L5130-L5142`): when `state === "COMPLETED"` and `!hasRtkForTask`, allow bounded `read_file` slices (`StartLine` and `EndLine` positive integers with `endLine - startLine + 1 <= MAX_SAFE_SLICE_LINES`), and update the unbounded degraded denial to recommend bounded `read_file` (`<= 150` lines) alongside `tail -n 150`/`head -n 150`. Keep `RUNNING` logs, `UNKNOWN` logs, unbounded `read_file`, and slices > 150 lines strictly denied.
   - In `scripts/execution-guard-hook.mjs#L5198-L5204` (`getDiscoveryGuidance`), when `!rtk`, recommend native `'grep_search'` first (e.g., `with 'grep_search' (or '${rgAvailable ? "rg" : "grep -rnE"}' via run_command)`), matching `L5278-L5280` and working natively on Windows ARM64.
   - Update `tests/test-output-governance.mjs` (degraded-mode block) and `tests/test-hook.mjs` (Group J.2) to assert bounded `read_file(StartLine=1, EndLine=150)` on a completed task log is allowed in degraded mode (while unbounded `read_file`, `StartLine=1, EndLine=200`, and `RUNNING` task logs stay denied) and degraded `read_file` denials mention `grep_search`.
8. **Acceptance evidence:** Passing `tests/test-output-governance.mjs` and `tests/test-hook.mjs` covering degraded bounded `read_file` on completed task logs, oversized/running denials, and `grep_search` discovery guidance.
9. **Root cause / related IDs:** `UX-ACS-002` degraded-mode remediation assumed POSIX `head`/`tail`/`grep` availability without aligning Section 2b with Section 2a's bounded `read_file` safe harbor or Section 2e with Section 2f's native `grep_search` pass-through.
10. **Closure:** Closed in Session 4 (`fix/ux-day-one-r2`): `scripts/execution-guard-hook.mjs#L5167-L5205` (Section 2b) allows bounded `read_file` slices (`StartLine`/`EndLine` positive integers, `<= 150` lines) on `COMPLETED` task logs when `!hasRtkForTask` while keeping `RUNNING`, `UNKNOWN`, unbounded, and `> 150`-line reads strictly denied, and updates unbounded degraded denials (`L5047-L5050`, `L5196`) to recommend bounded `read_file`; `scripts/execution-guard-hook.mjs#L5223-L5232` (`getDiscoveryGuidance`) recommends native `'grep_search'` first when `!rtk`; verified by `tests/test-output-governance.mjs#L588-L639` and `tests/test-hook.mjs#L2220-L2228`.

#### `UX-ACS-R2-003`: Windows `run_command` hook rewrite of bare `agy-context` emits a leading quoted `.cmd` path that fails PowerShell parsing when `%USERPROFILE%` contains spaces | P2 | Closed

1. **Title, priority, status:** Windows `run_command` hook rewrite of bare `agy-context` emits a leading quoted `.cmd` path that fails PowerShell parsing when `%USERPROFILE%` contains spaces, P2, Closed (Session 4).
2. **Contract provenance:** `plugin.json#L7-L11`, `README.md#L8`, and `docs/installation.md#L37` promise that inside Antigravity on Windows, bare `agy-context` commands (including all 3 `suggestedPrompts`) resolve automatically even when `~/.gemini/antigravity/bin` is not yet on `PATH`.
3. **Source evidence:** `scripts/execution-guard-hook.mjs#L829-L852` (`resolveInstalledAgyContextCommand`), `scripts/execution-guard-hook.mjs#L4969-L4980`, and `tests/test-hook.mjs#L2259-L2311` (Group J.3 only tests `os.tmpdir()` paths without spaces).
4. **Trigger:** A Windows user whose home directory contains a space (e.g., `C:\Users\Jane Doe`) installs via `npx --package=agy-context-saver agy-context setup`, reloads Antigravity Desktop IDE without adding `~/.gemini/antigravity/bin` to `PATH`, and clicks any `suggestedPrompt` (`agy-context transcript health`, `query`, or `read`) or runs `agy-context status` via `run_command`.
5. **Expected / actual:** Expected: the rewritten command executes cleanly in Windows PowerShell (Antigravity's default Windows shell) as well as `cmd.exe` and Git Bash. Actual: `resolveInstalledAgyContextCommand` (`L841-L842`) checks `agy-context.cmd` before `pluginCli` and returns `"C:\Users\Jane Doe\.gemini\antigravity\bin\agy-context.cmd"`, rewriting the command to `"C:\Users\Jane Doe\.gemini\antigravity\bin\agy-context.cmd" transcript health`. In Windows PowerShell, a command beginning with a double-quoted path (without `&`) is a syntax error (`Unexpected token 'transcript' in expression or statement`), failing all 3 `suggestedPrompts` on Day 1.
6. **Impact:** Windows developers with spaces in their user profile folder (a very common default on Windows personal and enterprise accounts) experience broken `suggestedPrompts` and bare `agy-context` calls inside Antigravity until they manually edit `PATH`.
7. **Required remediation:**
   - In `scripts/execution-guard-hook.mjs#L829-L852` (`resolveInstalledAgyContextCommand`), on `win32`, when `pluginCli` (`~/.gemini/config/plugins/agy-context-saver/bin/agy-context.mjs`) exists on disk (especially whenever `shimFile` contains whitespace, or unconditionally on `win32` since `node` is already required by Antigravity hooks), return `node "${pluginCli.replace(/\\/g, "/")}"`. Starting the command with bare `node` works identically across PowerShell, `cmd.exe`, and Git Bash even with spaces in `%USERPROFILE%`. Fall back to `shimFile` only when `pluginCli` is absent.
   - Add a regression assertion in `tests/test-hook.mjs` Group J.3 using a profile directory containing a space (for example `Jane Doe Profile`) verifying that rewritten `agy-context` commands execute cleanly and never emit a leading quoted `.cmd` path on `win32`.
8. **Acceptance evidence:** Passing `tests/test-hook.mjs` Group J.3 with spaced profile path assertions on POSIX and Windows.
9. **Root cause / related IDs:** `resolveInstalledAgyContextCommand` prioritized `.cmd` shim path formatting (`"..."`) over `node "..."` without accounting for PowerShell's leading-quote expression parsing rule. Related to `UX-ACS-003` (and analogous `resolveCachedHostEnv` local `rtk.exe` quoting noted in Section 8 as `UX-ACS-R2-006`).
10. **Closure:** Closed in Session 4 (`fix/ux-day-one-r2`): `scripts/execution-guard-hook.mjs#L829-L864` (`resolveInstalledAgyContextCommand`) checks `pluginCli` (`~/.gemini/config/plugins/agy-context-saver/bin/agy-context.mjs`) first on `win32` and returns `node "${pluginCli.replace(/\\/g, "/")}"`, falling back to `shimFile` only when `pluginCli` is absent; verified by `tests/test-hook.mjs#L2275-L2398` (including `Jane Doe Profile` spaced profile directory rewrite and shell execution assertions).

### 5.2 P3 actionable advisory table

| ID | Wave/Session | Cat | Status | Source | Defect / Proposal | Disposition / Fix | Verification |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `UX-ACS-R2-004` | Session 3 | SKILL | Closed | `skills/context-governance/SKILL.md#L24` | Publicly shipped skill still contains opaque internal requirement tag `` (`ACS-HOOK-09`) `` in `implicit grep commands stay unrewritten (\`ACS-HOOK-09\`);`, contradicting the strict internal-vs-public ledger boundary already cleaned up in `rules/AGENTS.md#L37` and `docs/tools.md#L15`. | Removed `` (`ACS-HOOK-09`) `` from `skills/context-governance/SKILL.md#L24` in Session 4. | Source inspection + public-boundary grep (0 hits) + `agy plugin validate --strict --json` (0 findings). |
| `UX-ACS-R2-005` | Session 3 | DOC | Closed | `SECURITY.md#L27` | `SECURITY.md` still states that `XDG_STATE_HOME` and `LOCALAPPDATA` overrides inside shell commands or scripts are unconditionally rejected, lagging PR #10's `UX-ACS-007` scoping (`scripts/execution-guard-hook.mjs#L253-L267`). | Updated `SECURITY.md#L27` in Session 4 to document unconditional blocking of `AGY_TEST_PROFILE_DIR`, `AGY_BRAIN_DIR`, and `GEMINI_CONVERSATION_ID`, and scoped blocking of `XDG_STATE_HOME` and `LOCALAPPDATA` in restricted child sessions and whenever a command or script targets governance or `.gemini` state. | Reconciled `SECURITY.md#L27` against `scripts/execution-guard-hook.mjs#L241-L267` and `tests/test-hook.mjs` Group J.4; 0 prose em dashes. |

---

## 6. Cross-Plugin Interactions, Strengths, & PR #11 Verification Plan

### 6.1 Cross-plugin summary (`Agy-Context-Saver` + `Agy-Squad`)

- **Standalone `Agy-Context-Saver`:** 10 of 13 Round-1 fixes are cleanly verified on disk, including zero global `~/.gitconfig` mutation (`UX-ACS-004`), scoped `XDG_STATE_HOME`/`LOCALAPPDATA` (`UX-ACS-007`), `AGY_DISABLE_BENCHMARK_GUARD=1` opt-out (`UX-ACS-008`), crisp top-level and subcommand `--help` (`UX-ACS-011`, `UX-ACS-012`), zero LaTeX noise in agent prompts (`UX-ACS-010`), and Windows `node.cmd` parity (`UX-ACS-006`). Fixing `UX-ACS-R2-001`, `UX-ACS-R2-002`, and `UX-ACS-R2-003` in a small stacked PR #11 removes the final Day-1 and Day-2 traps before tagging v2.0.4.
- **Paired with `Agy-Squad`:**
  1. Resolving `UX-ACS-R2-001` is essential for paired `Agy-Context-Saver` + `Agy-Squad` users because both installers place shims in `~/.gemini/antigravity/bin` and instruct users to add that directory to `PATH`; without `UX-ACS-R2-001`, upgrading `Agy-Context-Saver` via `npx` silently breaks `rtk` for all `Agy-Squad` `/swarm` workers too.
  2. Resolving `UX-ACS-R2-003` ensures `Agy-Squad` flat `audit-<id>` integrity auditors calling `agy-context transcript` on Windows accounts with spaces in `%USERPROFILE%` work reliably even before `PATH` updates.

### 6.2 What already works exceptionally well (preserve in PR #11)

- **Security & restricted-child hardening:** `UX-ACS-007` and `UX-ACS-008` preserved restricted-child isolation (`isRestrictedChild` enforcement on both `XDG_STATE_HOME`/`LOCALAPPDATA` and `AGY_DISABLE_BENCHMARK_GUARD=1`), and `parseDegradedBoundedHeadTailCommand` cleanly rejects `+N` offsets, oversized line counts, unknown flags, env prefixes, and multi-operand smuggling.
- **CLI help ergonomics (`bin/agy-context.mjs`):** Both top-level `--help` (`<= 93` cols + 4 practical examples) and all 12 dedicated subcommand `--help` pages are concise, scannable, and preserve `assertCleanHelp` + `consumeTranscriptAccessGrant`.
- **Non-destructive installer guarantees:** Zero `~/.gitconfig` mutation, fail-closed JSON preflight validation before any write or uninstall, unmanaged user `rtk` preservation, and safe `node.cmd.bak` backup/restore parity between `scripts/install-register.mjs` and `install.ps1`.
- **Documentation & packaging hygiene:** Zero prose `U+2014` em dashes across public docs, clean `zensical.toml` navigation including hardening and RTK support matrix docs, repo-neutral `--out` paths, and airtight `package.json` / `verify-package.mjs` exclusions of `docs/plans/**` and `docs/reviews/**`.

### 6.3 Verification plan for stacked PR #11

1. Branch PR #11 off `fix/ux-day-one-blockers` (`833e20df07a4c299bde302d4f8ad811a1b85c254`) and apply minimal targeted fixes for `UX-ACS-R2-001` through `UX-ACS-R2-005`:
   - `scripts/install-register.mjs` & `scripts/provision-rtk.mjs` (`UX-ACS-R2-001` unconditional `pluginDest/bin/rtk[.exe]` preservation + managed-shim recognition & stale-shim cleanup)
   - `scripts/execution-guard-hook.mjs` (`UX-ACS-R2-002` degraded bounded `read_file` on completed task logs + `grep_search` discovery hint; `UX-ACS-R2-003` `win32` `node "<pluginCli>"` resolution for spaces in `%USERPROFILE%`)
   - `skills/context-governance/SKILL.md#L24` (`UX-ACS-R2-004`) and `SECURITY.md#L27` (`UX-ACS-R2-005`)
2. Add targeted regression tests in `tests/test-lifecycle-rollback.mjs` (on-`PATH` copy-mode re-install/upgrade + stale managed shim cleanup), `tests/test-output-governance.mjs` (degraded bounded `read_file` on completed task log vs oversized/running denials), and `tests/test-hook.mjs` (degraded `grep_search` hint + spaced `AGY_TEST_PROFILE_DIR` bare `agy-context` rewrite).
3. Run full release verification pipeline:
   - `npm test` (all 12 suites passing)
   - `npm run preflight`
   - `npm run verify:package`
   - `agy plugin validate --strict --json` (0 findings)
   - Public-boundary grep (`LEDGER.md`, `ACS-HOOK-`, `L#`) and prose `U+2014` em-dash check.

---

## 7. Overall disposition and finding closure table

### 7.1 Overall disposition

- **Coverage:** Complete across all material categories (`ARCH`, `DOC`, `SKILL`, `RUN`, `SVC`, `SCRIPT`, `TEST`, `DEP`); `MCP` and `DB` Not applicable.
- **Blocking findings:** 0 open (all 5 actionable Round-2 findings `UX-ACS-R2-001`..`UX-ACS-R2-005` closed in Session 4; 3 deferred/informational residuals retained in Section 8).
- **Disposition:** Approve (`Content Verdict: PASS`).
- **Reason:** Session 4 resolved all 5 actionable Round-2 findings on stacked branch `fix/ux-day-one-r2` (PR #11 targeting PR #10) with surgical source fixes and dedicated regressions: `UX-ACS-R2-001` (managed `rtk` shim detection + unconditional `pluginDest/bin/rtk` preservation + stale-shim cleanup), `UX-ACS-R2-002` (degraded completed-task-log bounded `read_file` safe harbor + native `grep_search` discovery hint), `UX-ACS-R2-003` (`win32` `node "<pluginCli>"` resolution for spaces in `%USERPROFILE%`), `UX-ACS-R2-004` (`ACS-HOOK-09` tag removed from `SKILL.md`), and `UX-ACS-R2-005` (`SECURITY.md` env-scoping parity). Full release gates (`npm test` 12/12, `npm run preflight`, `npm run verify:package`, `agy plugin validate --strict --json`, public-boundary grep, and prose em-dash audit) passed with 0 defects.

### 7.2 Finding closure table (`1 ID = 1 Row`)

| ID | Category | Priority | Status | Summary | Evidence / Target Files |
| --- | --- | --- | --- | --- | --- |
| `UX-ACS-R2-001` | SCRIPT | P1 | Closed | Managed `rtk` shim on `PATH` recognized as local plugin RTK, `pluginDest/bin/{rtk,rtk.exe,rtk.cmd}` unconditionally preserved on copy upgrades, and stale/dangling managed shims cleaned up safely | `scripts/provision-rtk.mjs#L162-L263`, `scripts/install-register.mjs#L667-L711`, `L954-L1016`; `tests/test-lifecycle-rollback.mjs#L356-L473`, `tests/test-rtk-ledger-fresh-install.mjs#L194-L219` |
| `UX-ACS-R2-002` | RUN | P1 | Closed | Degraded mode allows bounded `read_file` (`<= 150` lines) on `COMPLETED` task logs while keeping `RUNNING`/`UNKNOWN`/oversized reads denied, and recommends native `grep_search` first | `scripts/execution-guard-hook.mjs#L5047-L5050`, `L5167-L5205`, `L5223-L5232`; `tests/test-output-governance.mjs#L588-L639`, `tests/test-hook.mjs#L2220-L2228` |
| `UX-ACS-R2-003` | RUN | P2 | Closed | On `win32`, `resolveInstalledAgyContextCommand` emits `node "<pluginCli>"` when `pluginCli` exists (falling back to `.cmd` only if absent), avoiding PowerShell leading-quote parse errors on spaced `%USERPROFILE%` paths | `scripts/execution-guard-hook.mjs#L829-L864`; `tests/test-hook.mjs#L2275-L2398` |
| `UX-ACS-R2-004` | SKILL | P3 | Closed | Removed opaque internal tag `` (`ACS-HOOK-09`) `` from publicly shipped `skills/context-governance/SKILL.md#L24` | `skills/context-governance/SKILL.md#L24`; public-boundary grep (0 hits), `agy plugin validate --strict --json` (0 findings) |
| `UX-ACS-R2-005` | DOC | P3 | Closed | Updated `SECURITY.md#L27` to document unconditional Antigravity env blocking and scoped `XDG_STATE_HOME`/`LOCALAPPDATA` blocking matching `UX-ACS-007` | `SECURITY.md#L27` reconciled against `scripts/execution-guard-hook.mjs#L241-L267` and `tests/test-hook.mjs` Group J.4 |

---

## 8. Post-Remediation Residuals & Deferred Dispositions

| ID | Wave/Session | Cat | Status | Source | Defect / Proposal | Disposition / Fix | Verification & Bundle SHA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `UX-ACS-014` | Session 1 | ARCH | Deferred / Won't Fix | `scripts/execution-guard-hook.mjs#L5196-L5312` | Read-only subagents whose host toolset omits `run_command` still receive `via run_command` redirect hints on `read_file`/`grep_search`/`find_by_name`/`list_dir` denials. | Deferred on external Antigravity host limitation: `PreToolUse` stdin JSON payloads do not expose the active session's available tool list. Revisit if Antigravity adds tool-capability metadata to `PreToolUse` payloads. | Source-derived inspection of `scripts/execution-guard-hook.mjs#L4667-L4678` |
| `UX-ACS-R2-006` | Session 3 | RUN | Deferred / Won't Fix | `scripts/execution-guard-hook.mjs#L969-L976` | On Windows with spaces in `%USERPROFILE%` and `~/.gemini/antigravity/bin` NOT yet on `PATH`, local `rtkPrefix` emits a leading double-quoted `rtk.exe` path (`"C:/Users/Jane Doe/.../rtk.exe" ...`), which PowerShell rejects unless preceded by `&` (while `cmd.exe` rejects `&`). | Deferred past v2.0.4: `PreToolUse` does not receive the active shell dialect (PowerShell vs `cmd.exe` vs Git Bash), so neither `& "..."` nor `"..."` works in both shells simultaneously; once `UX-ACS-R2-001` is fixed and the user adds `~/.gemini/antigravity/bin` to `PATH`, bare `rtk` resolves natively across all Windows shells. | Source-derived inspection of `scripts/execution-guard-hook.mjs#L969-L976` |
| `UX-ACS-R2-007` | Session 3 | SCRIPT | Informational | `scripts/install-register.mjs#L456`, `L1383-L1393` | After an intentional `--allow-degraded` install without RTK, `agy-context status` reports `PARTIAL INSTALLATION` and prints `Next step: run 'npx --package=agy-context-saver agy-context setup'`, which omits `--allow-degraded`. | Informational for post-v2.0.4 backlog: keeping `isComplete` gated on RTK >= 1.1.0 is intentional so missing RTK is never mistaken for a full install; a future release can mention `--allow-degraded` in the RTK-missing status hint without altering exit codes or JSON schema. | Source-derived inspection of `scripts/install-register.mjs#L447-L460`, `L1383-L1393` |
