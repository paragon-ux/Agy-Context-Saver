# Agy-Context-Saver v2.0.4 Final Launch UX & Merge-Gate Review (r3)

**Governing Standard:** Agy-Squad PR Review Standard 1.4.0
**Review type:** Independent Round-3 Final Launch UX & Merge-Gate Review (PR #11 Verification + Adversarial Regression Audit)
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
| Target | PR #11 (`fix/ux-day-one-r2`), stacked on PR #10 (`fix/ux-day-one-blockers`), stacked on PR #9 (`fix/v2.0.4-rtk-read-parity`), v2.0.4 npm release candidate |
| Comparison base | `fix/ux-day-one-blockers` (`833e20df07a4c299bde302d4f8ad811a1b85c254`) (PR #10 base: `fix/v2.0.4-rtk-read-parity` at `8b5695c6aa75eb33ccbefc16fe0f128597db78bf`) |
| Head / tree | `fix/ux-day-one-r2` (`4911a25a7cb43bd17731456593ec592e70757f27`) |
| Working-tree state | Clean commit-pinned verification of `4911a25a7cb43bd17731456593ec592e70757f27`; all 5 Round-2 findings (`UX-ACS-R2-001`..`UX-ACS-R2-005`) independently verified closed on disk with 0 new actionable regressions |
| CI revision | Session 4 executed local release verification gates on `fix/ux-day-one-r2` (`npm test` 12/12, `npm run preflight`, `npm run verify:package` 32 files, `agy plugin validate --strict --json` 0 findings, public-boundary grep 0 hits, prose em-dash check 0 hits); Session 5 performed independent read-only source and test-assertion verification at `4911a25a7cb43bd17731456593ec592e70757f27` |
| Prior reviews | `docs/reviews/UX-day-one-blockers/ux-day-one-review-r1.md` (Sessions 1 and 2) and `docs/reviews/UX-day-one-blockers/ux-day-one-review-r2.md` (Sessions 3 and 4) |

### 1.2 Session Provenance

| Session # | Operator Conversation ID | Parent Session | Date | Base..Head + Working-Tree State | Skill / Topology Invoked |
| --- | --- | --- | --- | --- | --- |
| 1 | `04291507-36ae-4728-a17a-149dbb4714f7` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `fix/v2.0.4-rtk-read-parity` at `8b5695c6aa75eb33ccbefc16fe0f128597db78bf` (read-only) | Read-only Launch UX Reviewer subagent (r1) |
| 2 | `e835beb8-0ad2-44fb-a713-108519c18ec8` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `8b5695c6aa75eb33ccbefc16fe0f128597db78bf..833e20df07a4c299bde302d4f8ad811a1b85c254` (remediated) | Launch UX Remediation Subagent (PR #10) |
| 3 | `ef8f5c58-2080-4500-bec2-522bb347e482` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `8b5695c6aa75eb33ccbefc16fe0f128597db78bf..833e20df07a4c299bde302d4f8ad811a1b85c254` (read-only) | Independent Round-2 Launch UX & Regression Reviewer subagent (r2) |
| 4 | `345a487d-1eb2-4e0a-af87-25bf3c9c8883` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `833e20df07a4c299bde302d4f8ad811a1b85c254..4911a25a7cb43bd17731456593ec592e70757f27` (remediated & verified) | Round-2 Launch UX Remediation Subagent (PR #11) |
| 5 | `c32c30a7-34b2-46ae-a78c-8d0725038510` | `a6f36288-2461-4e1f-96d5-bceff25feb98` | 2026-11-19 | `833e20df07a4c299bde302d4f8ad811a1b85c254..4911a25a7cb43bd17731456593ec592e70757f27` (read-only) | Independent Round-3 Final Launch UX & Merge-Gate Reviewer subagent (r3) |

### 1.3 Evidence available

- Independent bounded source inspection on disk at commit `4911a25a7cb43bd17731456593ec592e70757f27`:
  - Installer and RTK provisioner: `scripts/provision-rtk.mjs` (full 416 lines), `scripts/install-register.mjs` (profile path resolution, `isDirOnPath`, `formatPathOnboardingLines`, `detectExistingInstallation`, `formatManagedRtkShims`, `installManagedRtkShim`, `removeStaleManagedRtkShims`, `runInstall`, `runUninstall`, `runStatus`, CLI parser), `install.sh`, `install.ps1`.
  - Execution hook and CLI: `scripts/execution-guard-hook.mjs` (`isProtectedShellOrScriptOperation`, `matchTaskLogToken`, `resolveTaskPaths`, `getTaskState`, `findExecutableOnPath`, `resolveInstalledAgyContextCommand`, `resolveCachedHostEnv`, `parseDegradedBoundedHeadTailCommand`, `run_command` bare `agy-context` rewrite and Check 3/4, Section 2a/2b/2c/2e/2f), `bin/agy-context.mjs`.
  - Rules, skill, manifests, and public docs: `rules/AGENTS.md`, `skills/context-governance/SKILL.md`, `SECURITY.md`, `README.md`, `CHANGELOG.md`, `package.json`, `plugin.json`, `zensical.toml`, `docs/index.md`, `docs/installation.md`, `docs/governance.md`, `docs/RTK-SUPPORT-MATRIX.md`, `scripts/release-preflight.mjs`.
  - Automated regression suites: `tests/test-lifecycle-rollback.mjs` (`#L250-L540`), `tests/test-rtk-ledger-fresh-install.mjs` (full 258 lines), `tests/test-output-governance.mjs` (`#L525-L670`), `tests/test-hook.mjs` (`#L2150-L2450`), `tests/verify-package.mjs` (full 139 lines).
  - Prior review records: `docs/reviews/UX-day-one-blockers/ux-day-one-review-r1.md` and `docs/reviews/UX-day-one-blockers/ux-day-one-review-r2.md`.

### 1.4 Evidence limits

- Session 5 operated strictly read-only (`EnableWriteTools: false`, no shell execution); all verification claims below distinguish direct source and test-assertion inspection at `4911a25a7cb43bd17731456593ec592e70757f27` from Session 4's recorded local gate executions.
- Physical Windows ARM64, Windows PowerShell with spaces in `%USERPROFILE%`, and macOS Desktop IDE GUI hosts were not executed live in Session 5; cross-platform PowerShell, `cmd.exe`, and POSIX execution semantics were traced directly through the source paths and verified against the live `powershell -NoProfile -Command` and `/bin/sh -c` assertions added in `tests/test-hook.mjs#L2357-L2394` and the `win32` `cmd.exe` and `findExistingRtk` tests in `tests/test-lifecycle-rollback.mjs#L367-L376` and `tests/test-rtk-ledger-fresh-install.mjs#L194-L219`.
- Antigravity host `PreToolUse` payloads still do not disclose active session tool capabilities or active Windows shell dialect (carried forward in Section 8 as `UX-ACS-014` and `UX-ACS-R2-006`).

---

## 2. File/artifact-to-category inventory and coverage matrix

| Artifact | Role | Primary category | Cross-references | Coverage |
| --- | --- | --- | --- | --- |
| `scripts/provision-rtk.mjs` | Managed `rtk` shim detection (`scanPathForRtk`, `isManagedRtkShimFile`, `isSameDir`), local vs. external `PATH` fallback in `findExistingRtk`, SHA-256 download | SCRIPT | RUN, TEST, DOC | Complete |
| `scripts/install-register.mjs` | Unconditional `pluginDest/bin/{rtk,rtk.exe,rtk.cmd}` copy preservation, stale/dangling managed shim cleanup, unmanaged user `rtk` preservation, uninstall, status | SCRIPT | RUN, TEST, DOC | Complete |
| `scripts/execution-guard-hook.mjs` | Degraded completed-task-log bounded `read_file` safe harbor, `grep_search`-first `getDiscoveryGuidance`, `win32` `node "<pluginCli>"` bare `agy-context` rewrite | RUN | SCRIPT, SKILL, TEST | Complete |
| `skills/context-governance/SKILL.md`, `rules/AGENTS.md` | Publicly shipped skill and auto-loaded agent governance rules (public boundary and LaTeX hygiene) | SKILL | DOC, RUN | Complete |
| `SECURITY.md`, `README.md`, `CHANGELOG.md`, `zensical.toml`, `docs/*.md` | Security policy env-scoping parity, onboarding docs, RTK support matrix, docs navigation | DOC | RUN, SCRIPT, DEP | Complete |
| `bin/agy-context.mjs`, `install.sh`, `install.ps1` | CLI subcommands, Windows `node.cmd` parity, and POSIX/Windows installer wrappers | SCRIPT | SVC, DOC | Complete |
| `package.json`, `plugin.json`, `scripts/release-preflight.mjs` | Release metadata parity (2.0.4), `suggestedPrompts`, npm tarball inclusion/exclusion rules | DEP | DOC, TEST | Complete |
| `tests/test-lifecycle-rollback.mjs`, `tests/test-rtk-ledger-fresh-install.mjs`, `tests/test-output-governance.mjs`, `tests/test-hook.mjs`, `tests/verify-package.mjs` | PR #11 regression suites proving `UX-ACS-R2-001`..`UX-ACS-R2-003` and npm package boundary | TEST | SCRIPT, RUN, DEP | Complete |

| Category | Scope covered | Coverage | Verdict |
| --- | --- | --- | --- |
| ARCH | Architectural boundaries across `PreToolUse` hook, `agy-context` CLI, RTK >= 1.1.0, and companion `Agy-Squad` | Complete | No findings within reviewed scope |
| DOC | `SECURITY.md#L27`, `README.md`, `CHANGELOG.md`, `zensical.toml`, `docs/index.md`, `docs/installation.md`, `docs/governance.md`, `docs/RTK-SUPPORT-MATRIX.md` | Complete | No findings within reviewed scope (`UX-ACS-R2-005` verified closed) |
| SKILL | `skills/context-governance/SKILL.md#L24` and `rules/AGENTS.md` | Complete | No findings within reviewed scope (`UX-ACS-R2-004` verified closed) |
| MCP | Retired v1.x MCP server surface (`tests/verify-package.mjs#L41-L44`, `scripts/release-preflight.mjs#L142-L147`) | Complete | Not applicable |
| RUN | `scripts/execution-guard-hook.mjs` degraded task-log safe harbor, discovery guidance, `win32` bare `agy-context` rewrite, `resolveCachedHostEnv`, env scoping | Complete | No findings within reviewed scope (`UX-ACS-R2-002`, `UX-ACS-R2-003` verified closed) |
| SVC | Capability grants, lineage binding, and `bin/agy-context.mjs` CLI dispatch | Complete | No findings within reviewed scope |
| DB | Filesystem JSON/JSONL state only (no SQL or embedded database) | Complete | Not applicable |
| SCRIPT | `scripts/provision-rtk.mjs`, `scripts/install-register.mjs`, `install.sh`, `install.ps1` | Complete | No findings within reviewed scope (`UX-ACS-R2-001` verified closed) |
| TEST | PR #11 regression assertions across `test-lifecycle-rollback.mjs`, `test-rtk-ledger-fresh-install.mjs`, `test-output-governance.mjs`, `test-hook.mjs`, and `verify-package.mjs` | Complete | No findings within reviewed scope |
| DEP | `package.json`, `plugin.json`, `scripts/release-preflight.mjs`, `tests/verify-package.mjs` | Complete | No findings within reviewed scope |

---

## 3. Round-2 Closure Verification & Final Adversarial Regression Trace

### 3.1 Independent verification of Round-2 closure (`UX-ACS-R2-001`..`UX-ACS-R2-005`)

| Round-2 ID | Priority | Owning area | Independent source & test verification at `4911a25a` | Round-3 status |
| --- | --- | --- | --- | --- |
| `UX-ACS-R2-001` | P1 | Managed `rtk` shim on `PATH` + copy-mode preservation + stale-shim cleanup | Verified `scripts/provision-rtk.mjs#L120-L263` (`isManagedRtkShimFile` rejects symlinks and files > 4096 bytes and requires `MANAGED_SHIM_MARKER`; `normalizePathDir` + `isSameDir` normalize quotes, `~`, trailing slashes, `win32`/`darwin` casing, and `realpathSync`; `scanPathForRtk` tracks `firstHit` and `firstExternalHit`; `findExistingRtk` resolves a managed `firstHit` to `findLocalRtk()` with `isLocal: true`, falling back to `firstExternalHit` or `null`). Verified `scripts/install-register.mjs#L953-L1014` unconditionally preserves `pluginDest/bin/{rtk,rtk.exe,rtk.cmd}` across copy replacements regardless of `rtkResult?.isLocal`, and `#L667-L712` removes stale/dangling managed shims when `!rtkResult || !localRtkTarget` while `#L719-L749` never touches unmanaged user `rtk` files. Verified end-to-end tests in `tests/test-lifecycle-rollback.mjs#L356-L389`, `#L409-L470`, `#L484-L489` and `win32` test in `tests/test-rtk-ledger-fresh-install.mjs#L194-L219`. | Closed |
| `UX-ACS-R2-002` | P1 | Windows ARM64 `--allow-degraded` completed task logs + `grep_search` guidance | Verified `scripts/execution-guard-hook.mjs#L5167-L5206` allows bounded `read_file` (`StartLine`/`EndLine` positive integers, `endLine - startLine + 1 <= 150`) on `COMPLETED` task logs only when `!hasRtkForTask`, while strictly denying `RUNNING` (with proportional backoff), `UNKNOWN`, unbounded `read_file`, > 150-line slices, non-`read_file` inspection tools, and raw transcripts (`#L5209`). Verified degraded denials at `#L5047-L5050` and `#L5198` recommend bounded `read_file` alongside `head -n 150`/`tail -n 150`, and `getDiscoveryGuidance` (`#L5223-L5231`) recommends native `'grep_search'` first when `!rtk` (aligned with `#L5305-L5307`). Verified assertions in `tests/test-output-governance.mjs#L588-L639` and `tests/test-hook.mjs#L2220-L2228`. | Closed |
| `UX-ACS-R2-003` | P2 | Windows bare `agy-context` rewrite with spaces in `%USERPROFILE%` | Verified `scripts/execution-guard-hook.mjs#L829-L864` (`resolveInstalledAgyContextCommand`) checks `pluginCli` (`~/.gemini/config/plugins/agy-context-saver/bin/agy-context.mjs`) first on `win32` and emits `node "<pluginCli>"` with forward slashes (falling back to `.cmd` only when `pluginCli` is absent), avoiding PowerShell leading-quote syntax errors across PowerShell, `cmd.exe`, and Git Bash while preserving POSIX shim quoting and fallback. Verified `tests/test-hook.mjs#L2275-L2398` (including `Jane Doe Profile` spaced-path rewrite and live `powershell -NoProfile -Command` / `/bin/sh -c` execution). | Closed |
| `UX-ACS-R2-004` | P3 | Opaque internal tag `ACS-HOOK-09` in public `SKILL.md` | Verified `skills/context-governance/SKILL.md#L24` removed `` (`ACS-HOOK-09`) `` cleanly; inspected all 114 lines of `SKILL.md` and all 69 lines of `rules/AGENTS.md` and confirmed 0 internal requirement tags (`ACS-HOOK-*`, `LEDGER.md`, `L#`), 0 `$` LaTeX fragments, and 0 prose `U+2014` em dashes. | Closed |
| `UX-ACS-R2-005` | P3 | `SECURITY.md#L27` env-scoping parity with `UX-ACS-007` | Verified `SECURITY.md#L27` matches `scripts/execution-guard-hook.mjs#L241-L267` verbatim: `AGY_TEST_PROFILE_DIR`, `AGY_BRAIN_DIR`, and `GEMINI_CONVERSATION_ID` unconditionally blocked; `XDG_STATE_HOME` and `LOCALAPPDATA` blocked in restricted child sessions and whenever a command or script targets governance or `.gemini` state; 0 prose `U+2014` em dashes. | Closed |

### 3.2 Final adversarial regression trace

| Adversarial scenario traced | Code path audited at `4911a25a` | Result |
| --- | --- | --- |
| Windows `PATH` delimiters (`;`), case sensitivity, quoted entries with spaces (`"C:\Users\Jane Doe\.gemini\antigravity\bin"`), trailing slashes, and `.exe`/`.cmd`/`.bat` precedence in `scanPathForRtk` | `scripts/provision-rtk.mjs#L130-L199`, `#L204` | Pass: quotes stripped, `~` expanded, trailing slashes stripped, `win32`/`darwin` case-folded, `realpathSync` fallback active, `rtk.exe` checked ahead of `rtk.cmd`/`rtk.bat` so an unmanaged user `rtk.exe` is never misclassified as a managed shim. |
| Symlinked user `rtk` binary or broken user symlink inside `~/.gemini/antigravity/bin` | `scripts/provision-rtk.mjs#L120-L128`, `scripts/install-register.mjs#L637-L645`, `#L674-L688`, `#L719-L749`, `#L1226-L1236` | Pass: `fs.lstatSync` + `!st.isSymbolicLink()` + `st.size <= 4096` + `MANAGED_SHIM_MARKER` ensures user symlinks, broken symlinks, and unmanaged binaries are never misidentified, overwritten, or removed during setup, `--allow-degraded`, or uninstall. |
| Dangling managed `rtk` shim on `PATH` during fresh `npx` repair (no external `rtk` vs. external `rtk` later on `PATH` vs. `--allow-degraded`) | `scripts/provision-rtk.mjs#L231-L249`, `#L346`, `scripts/install-register.mjs#L701-L704` | Pass: returns `null` when local and external `rtk` are both absent (triggering fresh download into `_npx/.../bin` which `findLocalRtk` then verifies via `binDir`, or clean stale-shim deletion under `--allow-degraded`), and returns `firstExternalHit` (`isLocal: false`) when a compatible system `rtk` exists later on `PATH` (while `installManagedRtkShim` deletes the shadowing managed shim). |
| Incompatible system `rtk` (< 1.1.0) on `PATH` ahead of managed shim or behind dangling managed shim | `scripts/provision-rtk.mjs#L237-L263` | Pass: warns and falls back cleanly without accepting `< 1.1.0`. |
| Degraded-mode task-log `read_file` bypass attempts (`..` traversal, `transcript.jsonl`, `RUNNING`, `UNKNOWN`, `StartLine: 1, EndLine: 151`, `StartLine: 0`, float bounds, `grep_search`/`view_file` on task logs, RTK-present mode) | `scripts/execution-guard-hook.mjs#L477-L484`, `#L637-L693`, `#L757-L777`, `#L5167-L5214` | Pass: `matchTaskLogToken` requires `tasks/(task-)?<id>.log` suffix (rejecting `transcript.jsonl` and `..` escapes to non-log files), `getTaskState` returns `UNKNOWN` for missing logs, `RUNNING` triggers `denyRunningTask`, `hasRtkForTask` stays strictly routed to `rtk read`, non-`read_file` tools stay denied, and `StartLine`/`EndLine` require positive integers with span `<= 150`. |
| Windows `node "<pluginCli>"` command rewrite interactions (`agy-context` vs. `agy-context.cmd`, bare `agy-context status`, capability grants, restricted child denials, `self-only` `--id` injection) | `scripts/execution-guard-hook.mjs#L829-L864`, `#L4821-L4838`, `#L4871-L4877`, `#L4932-L4992`, `bin/agy-context.mjs#L1360-L1466` | Pass: restricted-child transcript and lifecycle denials execute ahead of `#L4980`, `recordTranscriptHookGrant` and `--id`/`--parent` injection complete before `#L4980`, `normalizeCmdName` strips `.cmd`/`.exe`/`.bat`, and rewritten `node "C:/Users/Jane Doe/.../agy-context.mjs" ...` passes verbatim to Node.js in PowerShell, `cmd.exe`, and Git Bash. |
| Local git-checkout symlink migration directly to `npx` copy mode without system `rtk` (pre-existing behavior check) | `scripts/install-register.mjs#L955-L1014`, `#L701-L704` | Non-blocking post-launch note: when migrating from a pre-existing local git-clone symlink (`pluginLst.isSymbolicLink()`) directly to `npx` copy mode without system `rtk`, `#L959` (`if (!pluginLst.isSymbolicLink())`) skips copying the old checkout's `bin/rtk` on the first run; however, PR #11 strictly improves this path because `removeStaleManagedRtkShims()` prevents any dangling shim, degraded mode keeps the user unblocked, `agy-context status` reports the missing RTK clearly, and a single re-run of `setup` provisions `rtk` cleanly. Not a PR #11 regression and not a v2.0.4 launch blocker; can be tightened post-v2.0.4 by checking `if (pluginExists)` at `#L959`. |

---

## 4. Category reviews

### 4.1 `ARCH`: Architecture and contracts
- **Scope:** Separation of concerns across `PreToolUse` hook, `agy-context` CLI, RTK >= 1.1.0, and companion `Agy-Squad`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope (host `PreToolUse` toolset-visibility constraint carried forward in Section 8 as `UX-ACS-014`).
- **Verification:** Reconciled `scripts/execution-guard-hook.mjs`, `scripts/install-register.mjs`, `scripts/provision-rtk.mjs`, `README.md`, and `docs/RTK-SUPPORT-MATRIX.md` at `4911a25a7cb43bd17731456593ec592e70757f27`.
- **Category Verdict:** No findings within reviewed scope.

### 4.2 `DOC`: Documentation and change records
- **Scope:** `SECURITY.md#L27`, `README.md`, `CHANGELOG.md`, `zensical.toml`, `docs/index.md`, `docs/installation.md`, `docs/governance.md`, `docs/RTK-SUPPORT-MATRIX.md`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope (`UX-ACS-R2-005` independently verified Closed in `SECURITY.md#L27`).
- **Verification:** Confirmed `SECURITY.md#L27` matches `scripts/execution-guard-hook.mjs#L241-L267` exactly, confirmed `zensical.toml#L11-L21` navigation completeness, confirmed `docs/installation.md` global uninstall and `PATH` onboarding parity, and verified 0 prose `U+2014` em dashes across reviewed public docs.
- **Category Verdict:** No findings within reviewed scope.

### 4.3 `SKILL`: Skills and agent instructions
- **Scope:** `skills/context-governance/SKILL.md` and `rules/AGENTS.md`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope (`UX-ACS-R2-004` independently verified Closed in `skills/context-governance/SKILL.md#L24`).
- **Verification:** Inspected all 114 lines of `skills/context-governance/SKILL.md` and all 69 lines of `rules/AGENTS.md`; confirmed 0 opaque internal tags (`ACS-HOOK-*`, `LEDGER.md`, `L#`), 0 raw `$` LaTeX fragments, and 0 prose `U+2014` em dashes.
- **Category Verdict:** No findings within reviewed scope.

### 4.4 `MCP`: MCP schemas and public API
- **Scope:** Retired v1.x MCP surface and cleanup guards in `scripts/install-register.mjs`, `scripts/release-preflight.mjs#L142-L147`, and `tests/verify-package.mjs#L41-L44`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed `mcp/` and `mcp_config.json` remain absent and denylisted across preflight and package verification.
- **Category Verdict:** Not applicable (no active MCP server shipped in v2.0.4).

### 4.5 `RUN`: Core runtime, parsing, and validation
- **Scope:** `scripts/execution-guard-hook.mjs` (`resolveInstalledAgyContextCommand`, `resolveCachedHostEnv`, `matchTaskLogToken`, `resolveTaskPaths`, `getTaskState`, `parseDegradedBoundedHeadTailCommand`, bare `agy-context` rewrite, Check 3/4, Section 2a/2b/2c/2e/2f, env-var scoping).
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope (`UX-ACS-R2-002` independently verified Closed).
- **P2 (medium priority):** None identified within reviewed scope (`UX-ACS-R2-003` independently verified Closed; `UX-ACS-R2-006` carried forward in Section 8).
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Independently verified degraded bounded `read_file` safe harbor on `COMPLETED` task logs (`#L5167-L5206`), strict `RUNNING`/`UNKNOWN`/oversized/transcript denials, `grep_search`-first `getDiscoveryGuidance` (`#L5223-L5231`), and `win32` `node "<pluginCli>"` resolution (`#L829-L864`) against all adversarial bypass and Windows quoting cases in Section 3.2.
- **Category Verdict:** No findings within reviewed scope.

### 4.6 `SVC`: Services, orchestration, and audit semantics
- **Scope:** Capability grant lifecycle ordering around `resolveInstalledAgyContextCommand` (`scripts/execution-guard-hook.mjs#L4821-L4992`) and `bin/agy-context.mjs` dispatch (`#L1-L100`, `#L380-L520`, `#L1360-L1466`).
- **Coverage:** Complete across PR #11 interaction points.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed `recordTranscriptHookGrant`, restricted-child access/lifecycle denials, and `self-only` `--id` injection all execute deterministically before bare `agy-context` command rewriting, and `bin/agy-context.mjs` executes identically via `node "<pluginCli>"` and `.cmd`/POSIX shims.
- **Category Verdict:** No findings within reviewed scope.

### 4.7 `DB`: Database, migrations, replay, and concurrency
- **Scope:** Filesystem JSON/JSONL state only (`scripts/state-dir.mjs`, `scripts/execution-guard-hook.mjs`).
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed filesystem-only state persistence with no database layer introduced in PR #11.
- **Category Verdict:** Not applicable.

### 4.8 `SCRIPT`: Scripts, evaluation, and developer tooling
- **Scope:** `scripts/provision-rtk.mjs`, `scripts/install-register.mjs`, `install.sh`, `install.ps1`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope (`UX-ACS-R2-001` independently verified Closed).
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope (`UX-ACS-R2-007` carried forward in Section 8).
- **Verification:** Independently verified `scanPathForRtk`, `isManagedRtkShimFile`, `normalizePathDir`, `isSameDir`, and `findExistingRtk` (`scripts/provision-rtk.mjs#L120-L263`), unconditional copy-mode `pluginDest/bin/{rtk,rtk.exe,rtk.cmd}` preservation (`scripts/install-register.mjs#L953-L1014`), and stale/dangling managed shim cleanup without disturbing unmanaged user `rtk` binaries (`scripts/install-register.mjs#L667-L749`, `#L1225-L1236`).
- **Category Verdict:** No findings within reviewed scope.

### 4.9 `TEST`: Tests and CI
- **Scope:** `tests/test-lifecycle-rollback.mjs#L250-L540`, `tests/test-rtk-ledger-fresh-install.mjs`, `tests/test-output-governance.mjs#L525-L670`, `tests/test-hook.mjs#L2150-L2450`, and `tests/verify-package.mjs`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Inspected concrete assertions (not just test titles) across every PR #11 test block and confirmed they genuinely prove: (1) on-`PATH` copy-mode re-install/upgrade preserves `pluginDest/bin/rtk`, keeps the managed shim executable, and preserves `status --json` `isComplete: true` / `isLocal: true` (`test-lifecycle-rollback.mjs#L356-L389`); (2) stale/dangling managed shim cleanup on `--allow-degraded` and external system `rtk` transition while preserving unmanaged user `rtk` (`#L409-L489`); (3) `win32` managed `rtk.cmd` detection returning local `isLocal: true` (`test-rtk-ledger-fresh-install.mjs#L194-L219`); (4) degraded bounded `read_file` allow on `COMPLETED` task logs vs. denials on unbounded, > 150 lines, `RUNNING`, `UNKNOWN`, and raw transcripts (`test-output-governance.mjs#L588-L639`) plus `'grep_search'` guidance (`test-hook.mjs#L2220-L2228`); and (5) `Jane Doe Profile` spaced-path bare `agy-context` rewrite with real `powershell` / `/bin/sh` execution (`test-hook.mjs#L2324-L2398`).
- **Category Verdict:** No findings within reviewed scope.

### 4.10 `DEP`: Dependencies, packaging, and configuration
- **Scope:** `package.json`, `plugin.json`, `scripts/release-preflight.mjs`, `tests/verify-package.mjs`.
- **Coverage:** Complete.
- **P1 (high priority):** None identified within reviewed scope.
- **P2 (medium priority):** None identified within reviewed scope.
- **P3 (low priority):** None identified within reviewed scope.
- **Verification:** Confirmed `package.json` and `plugin.json` version parity (2.0.4), zero runtime npm dependencies, `Node >= 22`, valid `suggestedPrompts` and `assets/logo.svg`, and strict `docs/plans/**` + `docs/reviews/**` tarball exclusions in both `package.json#L43-L62` and `tests/verify-package.mjs#L63-L118`.
- **Category Verdict:** No findings within reviewed scope.

---

## 5. Findings

### 5.1 P0/P1/P2 finding records

None. 0 new or remaining P0, P1, or P2 launch blockers were identified at commit `4911a25a7cb43bd17731456593ec592e70757f27`. All 3 P1/P2 findings from Round 2 (`UX-ACS-R2-001`, `UX-ACS-R2-002`, and `UX-ACS-R2-003`) are independently verified Closed in Section 3.1 and Section 7.2.

### 5.2 P3 actionable advisory table

None. Both Round-2 P3 findings (`UX-ACS-R2-004` and `UX-ACS-R2-005`) are independently verified Closed at commit `4911a25a7cb43bd17731456593ec592e70757f27`.

---

## 6. Cross-Plugin Launch Readiness, Strengths, & Verification Record

### 6.1 Cross-plugin interaction (`Agy-Context-Saver` standalone vs. paired with `Agy-Squad`)

- **Standalone `Agy-Context-Saver` v2.0.4:** Ready for external Day-1 adoption across Linux, macOS, and Windows (x64 and Windows ARM64 `--allow-degraded`) in both Antigravity Desktop IDE and `agy` CLI. Fresh `npx` installs, Day-1 `PATH` onboarding followed by `npx` upgrades, Windows accounts with spaces in `%USERPROFILE%`, Windows ARM64 degraded mode, and clean uninstallation/rollback all work coherently without touching `~/.gitconfig` or unmanaged user `rtk` binaries.
- **Paired with `Agy-Squad` v0.1.3:** Both plugins share `~/.gemini/antigravity/bin` cleanly:
  1. `UX-ACS-R2-001` ensures upgrading `Agy-Context-Saver` via `npx` after adding `~/.gemini/antigravity/bin` to `PATH` never breaks `rtk` for `/swarm` workers or leaves a dangling shim shadowing system `rtk`.
  2. `UX-ACS-R2-003` ensures `Agy-Squad` flat `audit-<id>` integrity auditors calling `agy-context transcript` on Windows profiles with spaces execute reliably even before users update `PATH`.
  3. Restricted-child non-bypassability on `XDG_STATE_HOME`, `LOCALAPPDATA`, `AGY_DISABLE_BENCHMARK_GUARD=1`, and plugin lifecycle commands keeps parent-scoped `/swarm` isolation intact.

### 6.2 What already works exceptionally well (preserve in future releases)

- **Layered managed-shim safety (`scripts/provision-rtk.mjs` + `scripts/install-register.mjs`):** Combining `MANAGED_SHIM_MARKER` verification (`lstatSync`, non-symlink, `<= 4096` bytes), `realpathSync`-aware directory matching, unconditional copy-mode binary preservation, and stale-shim cleanup makes `npx` upgrades idempotent without ever risking user-owned `rtk` binaries.
- **Symmetric degraded-mode governance (`scripts/execution-guard-hook.mjs`):** Aligning Section 2b completed task logs with Section 2a spillovers (`read_file <= 150` lines) and recommending native `grep_search` first unblocks Windows ARM64 and offline developers while preserving every security boundary (`RUNNING`, `UNKNOWN`, > 150 lines, and raw `.system_generated/logs/` transcripts remain strictly denied).
- **High-signal regression tests:** Rather than shallow mock checks, the PR #11 tests execute real shims (`--version`), real `powershell -NoProfile -Command` / `/bin/sh -c` commands on spaced profile directories (`Jane Doe Profile`), and negative security assertions (`RUNNING`, `UNKNOWN`, oversized slices, raw transcripts, unmanaged user `rtk` survival).
- **Release & packaging discipline:** Zero runtime dependencies, 12 hermetic test suites, fail-closed `release-preflight.mjs`, `verify-package.mjs` whitelist/denylist enforcement excluding `docs/plans/**` and `docs/reviews/**`, and clean public-boundary hygiene across `SKILL.md`, `AGENTS.md`, `SECURITY.md`, and Zensical docs.

### 6.3 Verification record and post-launch backlog notes

- **Source & test inspection (Session 5, commit `4911a25a7cb43bd17731456593ec592e70757f27`):** All 5 Round-2 remediations and all corresponding PR #11 test assertions verified directly on disk across all 10 review categories.
- **Recorded local gate execution (Session 4, `fix/ux-day-one-r2`):** `npm test` (12/12 suites passing), `npm run preflight`, `npm run verify:package` (32 packaged files, `docs/plans/**` and `docs/reviews/**` excluded), `agy plugin validate --strict --json` (0 findings), public-boundary grep (0 hits), and prose `U+2014` em-dash check (0 hits).
- **Post-v2.0.4 hardening note (non-blocking):** In a future patch release, `scripts/install-register.mjs#L959` can broaden `if (!pluginLst.isSymbolicLink())` to `if (pluginExists)` so users migrating in one step from a local git-checkout symlink to `npx` copy mode without system `rtk` carry over their local checkout `bin/rtk` without needing a second `setup` run (`#L1004` already prevents writing into symlink destinations).

---

## 7. Overall disposition and finding closure table

### 7.1 Overall disposition

- **Launch Verdict:** **SHIP NOW**
- **Coverage:** Complete across all material categories (`ARCH`, `DOC`, `SKILL`, `RUN`, `SVC`, `SCRIPT`, `TEST`, `DEP`); `MCP` and `DB` Not applicable.
- **Blocking findings:** 0 open (all 5 Round-2 findings `UX-ACS-R2-001`..`UX-ACS-R2-005` independently verified Closed at commit `4911a25a7cb43bd17731456593ec592e70757f27`; 0 new actionable regressions introduced; 3 already-deferred/informational items carried forward in Section 8).
- **Disposition:** Approve (`Content Verdict: PASS`).
- **Reason:** PR #11 (`fix/ux-day-one-r2` at `4911a25a7cb43bd17731456593ec592e70757f27`, stacked on PR #10 and PR #9) cleanly and completely resolves every Round-2 Day-1 and Day-2 launch defect with surgical fixes and genuine end-to-end regression coverage. Adversarial checks across Windows `PATH` parsing, symlinked or unmanaged `rtk` binaries, stale/dangling managed shims, degraded-mode task-log boundaries, and Windows spaced `%USERPROFILE%` command rewrites found 0 new launch blockers. `agy-context-saver@2.0.4` is ready to merge, tag, and ship publicly tomorrow.

### 7.2 Finding closure table (`1 ID = 1 Row`)

| ID | Category | Priority | Status | Summary | Evidence / Target Files |
| --- | --- | --- | --- | --- | --- |
| `UX-ACS-R2-001` | SCRIPT | P1 | Closed | Managed `rtk` shim on `PATH` recognized as local plugin RTK (`isLocal: true`) with external `PATH` fallback, `pluginDest/bin/{rtk,rtk.exe,rtk.cmd}` unconditionally preserved on copy upgrades, and stale/dangling managed shims removed without touching unmanaged user `rtk` binaries | `scripts/provision-rtk.mjs#L120-L263`, `scripts/install-register.mjs#L667-L749`, `#L953-L1014`; `tests/test-lifecycle-rollback.mjs#L356-L389`, `#L409-L489`, `tests/test-rtk-ledger-fresh-install.mjs#L194-L219` |
| `UX-ACS-R2-002` | RUN | P1 | Closed | Degraded mode allows bounded `read_file` (<= 150 lines) on `COMPLETED` task logs while keeping `RUNNING`, `UNKNOWN`, oversized (> 150 lines), non-`read_file`, and raw transcript reads strictly denied, and recommends native `grep_search` first | `scripts/execution-guard-hook.mjs#L5047-L5050`, `#L5167-L5206`, `#L5223-L5231`; `tests/test-output-governance.mjs#L588-L639`, `tests/test-hook.mjs#L2220-L2228` |
| `UX-ACS-R2-003` | RUN | P2 | Closed | On `win32`, `resolveInstalledAgyContextCommand` resolves `node "<pluginCli>"` first (falling back to `.cmd` only when `pluginCli` is absent), avoiding PowerShell leading-quote parse errors on spaced `%USERPROFILE%` paths | `scripts/execution-guard-hook.mjs#L829-L864`; `tests/test-hook.mjs#L2275-L2398` |
| `UX-ACS-R2-004` | SKILL | P3 | Closed | Removed opaque internal requirement tag `` (`ACS-HOOK-09`) `` from publicly shipped `skills/context-governance/SKILL.md#L24` | `skills/context-governance/SKILL.md#L24`; full file inspection of `SKILL.md` (114 lines) and `rules/AGENTS.md` (69 lines) confirmed 0 internal tags and 0 prose em dashes |
| `UX-ACS-R2-005` | DOC | P3 | Closed | Aligned `SECURITY.md#L27` with unconditional Antigravity env blocking (`AGY_TEST_PROFILE_DIR`, `AGY_BRAIN_DIR`, `GEMINI_CONVERSATION_ID`) and scoped `XDG_STATE_HOME`/`LOCALAPPDATA` blocking | `SECURITY.md#L27` reconciled against `scripts/execution-guard-hook.mjs#L241-L267` and `tests/test-hook.mjs#L2403-L2450` |

---

## 8. Post-Remediation Residuals & Deferred Dispositions

| ID | Wave/Session | Cat | Status | Source | Defect / Proposal | Disposition / Fix | Verification & Bundle SHA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `UX-ACS-014` | Session 1 | ARCH | Deferred / Won't Fix | `scripts/execution-guard-hook.mjs#L5223-L5337` | Read-only subagents whose host toolset omits `run_command` still receive `via run_command` redirect hints on `read_file`/`grep_search`/`find_by_name`/`list_dir` denials. | Deferred on external Antigravity host limitation: `PreToolUse` stdin JSON payloads do not expose the active session's available tool list. Revisit if Antigravity adds tool-capability metadata to `PreToolUse` payloads. | Source-derived inspection of `scripts/execution-guard-hook.mjs#L5223-L5337` at `4911a25a7cb43bd17731456593ec592e70757f27` |
| `UX-ACS-R2-006` | Session 3 | RUN | Deferred / Won't Fix | `scripts/execution-guard-hook.mjs#L981-L988` | On Windows with spaces in `%USERPROFILE%` and `~/.gemini/antigravity/bin` NOT yet on `PATH`, local `rtkPrefix` emits a leading double-quoted `rtk.exe` path (`"C:/Users/Jane Doe/.../rtk.exe" ...`), which PowerShell rejects unless preceded by `&` (while `cmd.exe` rejects `&`). | Deferred past v2.0.4: `PreToolUse` does not receive the active shell dialect (PowerShell vs. `cmd.exe` vs. Git Bash), so neither `& "..."` nor `"..."` works in both shells simultaneously; with `UX-ACS-R2-001` closed, adding `~/.gemini/antigravity/bin` to `PATH` resolves bare `rtk` natively across all Windows shells and remains safe across upgrades. | Source-derived inspection of `scripts/execution-guard-hook.mjs#L981-L988` at `4911a25a7cb43bd17731456593ec592e70757f27` |
| `UX-ACS-R2-007` | Session 3 | SCRIPT | Informational | `scripts/install-register.mjs#L455`, `#L1403-L1413` | After an intentional `--allow-degraded` install without RTK, `agy-context status` reports `PARTIAL INSTALLATION` and prints `Next step: run 'npx --package=agy-context-saver agy-context setup'`, which omits `--allow-degraded`. | Informational for post-v2.0.4 backlog: keeping `isComplete` gated on RTK >= 1.1.0 is intentional so missing RTK is never mistaken for a full install; a future release can mention `--allow-degraded` in the RTK-missing status hint without altering exit codes or JSON schema. | Source-derived inspection of `scripts/install-register.mjs#L446-L460`, `#L1403-L1413` at `4911a25a7cb43bd17731456593ec592e70757f27` |
