# PR #9 Review & Remediation Ledger (`fix/v2.0.4-rtk-read-parity`)

## 1. Review Metadata, Session Provenance & Evidence Limits

- **Repository:** `paragon-ux/Agy-Context-Saver`
- **Pull Request:** [PR #9](https://github.com/paragon-ux/Agy-Context-Saver/pull/9) (`fix/v2.0.4-rtk-read-parity` into `main`)
- **Review Date:** 2026-11-18
- **Review Standard:** Agy-Squad PR Review Standard `1.4.0` (adapted for `Agy-Context-Saver`: normative provenance in [LEDGER.md](../plans/LEDGER.md) `L55`, zero MCP server surface, filesystem-only state, companion `Agy-Squad` untouched)
- **Base SHA:** `8dea2b9` (`origin/main`)
- **Pre-Remediation Head SHA:** `dba51fbf7217aa438ff77c682d073c7f6df5fe91`
- **Verified Remediation Head SHA:** `6531c48e467aa711a155e5e3381d8bb7fb5ef429` (`GH CI 7/7 success`, Neon High `APPROVE` on `seq #6`) + final `PR9-RUN-008` / `[INFO]` follow-up commit on `fix/v2.0.4-rtk-read-parity`
- **Primary Evidence Inspected:** [LEDGER.md](../plans/LEDGER.md) (`L32`–`L55`), [CHANGELOG.md](https://github.com/paragon-ux/Agy-Context-Saver/blob/main/CHANGELOG.md), `.github/workflows/ci-matrix.yml`, `.github/workflows/docs.yml`, `.github/workflows/release-tag.yml`, `scripts/execution-guard-hook.mjs`, `tests/helpers/hermetic-fixture.mjs`, `tests/test-hook.mjs`, `tests/test-output-governance.mjs`, `tests/test-rtk-integration.mjs`, live host `rtk 1.1.0`, local test/package/plugin checks, and GitHub Actions runs on `dba51fb` and `6531c48` (`44425344724`, `44425344726`).
- **Evidence Limits:** Local `zensical` CLI is unavailable on this host (`Documentation/build` runs remotely in GitHub Actions); desktop IDE live UI tool dispatch on macOS/Windows is outside local Linux execution (covered remotely via Node 22/24 CI on `ubuntu-latest`, `macos-latest`, and `windows-latest` using hermetic `setupHermeticTestEnv` tests).

### Session Provenance

| Session # | Operator Conversation ID | Parent Session | Date | Base..Head + Working-Tree State | Skill / Topology Invoked |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `ac544c8c-7b0f-4f5c-a28d-45aaa3306605` | - | 2026-11-18 | `8dea2b9..dba51fb` (clean) | Implementation of `L55`, PR #9 creation, local suite + GH CI |
| 2 | `42581d18-fb86-474a-a1c9-19f162d4cdb2` | `ac544c8c-7b0f-4f5c-a28d-45aaa3306605` | 2026-11-18 | `8dea2b9..dba51fb` (clean) | `/boost` `DeepInvestigator` (`pro`) full-diff + CI review |
| 3 | `38fcb21b-f3f1-49d9-910e-5b14d2f00b1d` | `ac544c8c-7b0f-4f5c-a28d-45aaa3306605` | 2026-11-18 | `8dea2b9..dba51fb` (clean) | Native `/swarm` `reviewer` (`gemini-4-neon-high`, board `#3`) + host `rtk 1.1.0` probes |
| 4 | `09dfd1b6-82f8-406b-8551-a19187596ba7` | `ac544c8c-7b0f-4f5c-a28d-45aaa3306605` | 2026-11-18 | `8dea2b9..dba51fb` (clean) | `/btw` reconciliation -> 14 atomic `1 ID = 1 Row` records & plan |
| 5 | `ac544c8c-7b0f-4f5c-a28d-45aaa3306605` | - | 2026-11-18 | `8dea2b9..6531c48` (clean) | `/pr-review` (`v1.4.0`) remediation (`PR9-RUN-001`..`007`, `PR9-TEST-001`, `PR9-DOC-001`..`006`), `npm test` 12/12 + GH CI `7/7` |
| 6 | `38fcb21b-f3f1-49d9-910e-5b14d2f00b1d` | `ac544c8c-7b0f-4f5c-a28d-45aaa3306605` | 2026-11-18 | `8dea2b9..6531c48` (clean) | Native `/swarm` `reviewer` (`gemini-4-neon-high`, board `#6`): `APPROVE`, surfaced 1 LOW (`PR9-RUN-008`) & 2 INFO notes |
| 7 | `ac544c8c-7b0f-4f5c-a28d-45aaa3306605` | - | 2026-11-18 | `6531c48` + `PR9-RUN-008` / INFO follow-up | Rectified leading `./` / `activeHookCwd` cross-session paths (`PR9-RUN-008`), `cat` shim flags (`-A`/`-b`/`-n`), and ledger finality |

---

## 2. File-to-Category Inventory & Coverage Matrix

| Artifact | Primary Category | Secondary Categories | Post-Remediation Status |
| :--- | :--- | :--- | :--- |
| `scripts/execution-guard-hook.mjs` | `RUN` | `ARCH`, `SVC`, `SCRIPT` | Reviewed & remediated (`PR9-RUN-001`..`006` Closed; `PR9-RUN-007` Closed (By Design)) |
| `tests/helpers/hermetic-fixture.mjs` | `TEST` | `RUN` | Reviewed & remediated (`PR9-TEST-001` Closed) |
| `tests/test-output-governance.mjs` | `TEST` | `RUN`, `SVC` | Reviewed & remediated (`PR9-TEST-001`, `PR9-RUN-001`..`007` coverage Closed) |
| `tests/test-rtk-integration.mjs` | `TEST` | `RUN` | Reviewed & remediated (`PR9-TEST-001` live `rtk 1.1.0` & shim parity Closed) |
| `tests/test-hook.mjs` | `TEST` | `RUN` | Reviewed & remediated (`PR9-DOC-002` `read_many_files` & workspace assertions Closed) |
| `rules/AGENTS.md` | `SKILL` | `DOC` | Reviewed & remediated (`PR9-DOC-001`, `PR9-DOC-002`, `PR9-DOC-006` Closed) |
| `skills/context-governance/SKILL.md` | `SKILL` | `DOC` | Reviewed & remediated (`PR9-DOC-001`, `PR9-DOC-002`, `PR9-DOC-006` Closed) |
| [architecture.md](../architecture.md) | `DOC` | `ARCH` | Reviewed & remediated (`PR9-DOC-001`, `PR9-DOC-005` Closed) |
| [governance.md](../governance.md) | `DOC` | `ARCH` | Reviewed & remediated (`PR9-DOC-001`, `PR9-DOC-002` Closed) |
| [tools.md](../tools.md) | `DOC` | `ARCH` | Reviewed & remediated (`PR9-DOC-001`, `PR9-DOC-002` Closed) |
| [publishing.md](../publishing.md) | `DOC` | `DEP` | Reviewed & remediated (`PR9-DOC-004` Closed) |
| [LEDGER.md](../plans/LEDGER.md) | `DOC` | `ARCH` | Reviewed & remediated (`L55` set `in PR 9`, `PR9-DOC-003` Closed) |
| `CHANGELOG.md` | `DOC` | - | Reviewed & remediated (`## [2.0.4] - 2026-11-18` updated, `PR9-DOC-003` Closed) |
| [pr-9-v2.0.4-rtk-read-parity.md](pr-9-v2.0.4-rtk-read-parity.md) | `DOC` | `ARCH` | Created per Standard `v1.4.0` |
| Unchanged packaging/runtime dependencies inspected | `DEP`, `MCP`, `DB` | - | `DEP` verified (`preflight`, `verify:package` 35 files under `docs/`, `agy plugin validate`); `MCP` & `DB` Not applicable |

---

## 3. Architecture-to-Implementation Trace (`L55`)

- **Design Thesis / Invariants (`L32`–`L55`):** Protect Antigravity `.system_generated/` logs/transcripts and `getStateDir()` against exfiltration or busy-polling loops (`LH-02`, `LH-03`, `L6` isolation), keep editable workspace files on bounded 1-indexed `read_file` slices (`<= 150` lines or explicit full-file `<= 800` lines / `<= 45 KiB`), and let completed `tasks/<taskId>.log` and step spillovers inspect cleanly via single-operand bounded `rtk read` without contradictory denial bounce loops.
- **Decision (`L55` in [LEDGER.md](../plans/LEDGER.md)):**
  1. Allow post-rewrite `rtk read` on `COMPLETED` `tasks/*.log` while preserving `!isExplicitRtkRead` on `UNKNOWN` task logs, proportional backoff on `RUNNING` logs, and fail-closed rejection of leading env prefixes (`PR9-RUN-007` Closed (By Design)).
  2. Never weaken `Check 1`, `Check 2`, or `Check 4` via multi-operand `cat` / `rtk read` piggybacking: enforce strict single-operand parsing (`parseRtkReadCommand()`), `--` flag termination, `1..150` line-limit validation, and single-token stripping in `Check 1`.
  3. Expand `~/` (`expandLeadingTilde()`), resolve relative `<otherConvId>/.system_generated/tasks/...` and non-`task-` basenames across `getBrainDirs()`, and match quoted paths containing spaces cleanly (`extractTaskLogMatches()`, `matchTaskLogToken()`).
  4. Remove workspace `rtk read` fallback nudges from `getDiscoveryGuidance()`, keep `read_many_files` safe across editable code (bounded `read_file`) vs. read-only logs (`rtk read`), and eliminate bidirectional `> 45 KiB` task-log / spillover bounce loops.
- **Public Contract:** Rules (`rules/AGENTS.md`), skill (`skills/context-governance/SKILL.md`), and user docs (`docs/architecture.md`, `docs/governance.md`, `docs/tools.md`, `docs/publishing.md`) align verbatim with `rtk 1.1.0` rewrite boundaries (`cat` and single unquoted forward-slash `head -n` / `tail -n`; explicit `rtk read` otherwise).
- **Implementation & Verification:** Remediated across `scripts/execution-guard-hook.mjs`, `tests/helpers/hermetic-fixture.mjs`, `tests/test-output-governance.mjs`, `tests/test-rtk-integration.mjs`, `tests/test-hook.mjs`, and docs, then synced (`agy-context setup`) and re-tested across live host `rtk 1.1.0` and hermetic suites.

---

## 4. Mandatory Category Records

### `ARCH` - Architecture and Contracts
1. **Scope:** Internal-state containment boundary, Check 1–4 ordering, workspace read discipline, and [LEDGER.md](../plans/LEDGER.md) `L55` provenance.
2. **Coverage:** Complete across PR #9 diff and surrounding hook dispatch.
3. **P1 (high priority):** None identified within reviewed scope after `PR9-RUN-001` remediation.
4. **P2 (medium priority):** None identified within reviewed scope (`PR9-RUN-002`..`004` resolved).
5. **P3 (low priority):** None identified within reviewed scope.
6. **Verification:** Inspected `L55` contract against hook ordering in `scripts/execution-guard-hook.mjs#L4694-L4889` and `tests/test-output-governance.mjs`.
7. **Category Verdict:** No findings within reviewed scope (pending remote CI + Neon High recheck on follow-up commit).

### `DOC` - Documentation and Change Records
1. **Scope:** [architecture.md](../architecture.md), [governance.md](../governance.md), [tools.md](../tools.md), [publishing.md](../publishing.md), [LEDGER.md](../plans/LEDGER.md), `CHANGELOG.md`, and [pr-9-v2.0.4-rtk-read-parity.md](pr-9-v2.0.4-rtk-read-parity.md).
2. **Coverage:** Complete across all changed docs and pre-existing doc drift items surfaced in Passes 1–2.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** `PR9-DOC-001` (Closed). See Section 5.
5. **P3 (low priority):** `PR9-DOC-002` (Closed), `PR9-DOC-003` (Closed), `PR9-DOC-004` (Closed), `PR9-DOC-005` (Closed). See Section 5.
6. **Verification:** Cross-checked doc statements against live `rtk 1.1.0 hook antigravity` output, `verify:package` output (`34` files on `dba51fb`, `+1` for this review doc), and zero prose em-dash check. Remote `Documentation/build` (`zensical build`) re-runs on follow-up push.
7. **Category Verdict:** No findings within reviewed scope (pending remote `zensical build` re-run on follow-up commit).

### `SKILL` - Skills and Agent Instructions
1. **Scope:** `rules/AGENTS.md` and `skills/context-governance/SKILL.md`.
2. **Coverage:** Complete.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** Cross-referenced `PR9-DOC-001` (tracked in `DOC`; Closed).
5. **P3 (low priority):** `PR9-DOC-006` (Closed; updated `TimerCondition="<convId>/task-X"` at `rules/AGENTS.md#L18` and `skills/context-governance/SKILL.md#L108`). See Section 5.
6. **Verification:** Inspected both files end-to-end, scanned for zero Unicode em dashes, and checked runtime `schedule` condition contract.
7. **Category Verdict:** No findings within reviewed scope.

### `MCP` - MCP Schemas and Public API
1. **Scope:** Verified unchanged repo footprint (`package.json`, `plugin.json`, `RETIRED_DENYLIST` in `tests/verify-package.mjs#L42-L45`).
2. **Coverage:** Complete.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** None identified within reviewed scope.
5. **P3 (low priority):** None identified within reviewed scope.
6. **Verification:** `agy plugin validate --strict --json` reports `mcpServers: 0`, `findings: []`; `verify:package` rejects retired `mcp_config.json` and `mcp/index.js`.
7. **Category Verdict:** Not applicable (`Agy-Context-Saver` retired MCP in v2.0.0 and ships zero MCP servers).

### `RUN` - Core Runtime, Parsing, and Validation
1. **Scope:** `scripts/execution-guard-hook.mjs` (`matchTaskLogToken`, `extractTaskLogMatches`, `resolveTaskPaths`, `resolveInternalReadStatPaths`, `isOversizedInternalTarget`, `parseRtkReadCommand`, `Check 1`..`Check 4`, `> 45 KiB` bounds, `2a`, `2b`, `2e`, `2f`).
2. **Coverage:** Complete across PR #9 diff and connected runtime handlers.
3. **P1 (high priority):** `PR9-RUN-001` (Closed). See Section 5.
4. **P2 (medium priority):** `PR9-RUN-002` (Closed), `PR9-RUN-003` (Closed), `PR9-RUN-004` (Closed). See Section 5.
5. **P3 (low priority):** `PR9-RUN-005` (Closed), `PR9-RUN-006` (Closed); `PR9-RUN-007` settled as Closed (By Design) in Section 8.
6. **Verification:** Verified directly against `tests/test-output-governance.mjs`, `tests/test-rtk-integration.mjs` (live host `rtk 1.1.0`), `tests/test-hook.mjs`, and full `npm test` after `agy-context setup`.
7. **Category Verdict:** No findings within reviewed scope (pending remote CI + Neon High recheck on follow-up commit).

### `SVC` - Services, Orchestration, and Audit Semantics
1. **Scope:** Session polling ledger (`getSessionState`, `denyRunningTask`), `getTaskState` cross-session resolution, and `agy-context setup` mirrored hook synchronization (`scripts/install-register.mjs`).
2. **Coverage:** Complete for modified runtime surfaces.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** Cross-referenced `PR9-RUN-001` (`RUNNING` ordering across multi-match commands) and `PR9-RUN-004` (cross-session `RUNNING` state lookup), both tracked in `RUN` and Closed.
5. **P3 (low priority):** None identified within reviewed scope.
6. **Verification:** `agy-context setup` and `agy-context status --json` (`mirroredHookStale: false`), plus multi-conversation polling tests in `tests/test-output-governance.mjs`.
7. **Category Verdict:** No findings within reviewed scope.

### `DB` - Database, Migrations, Replay, and Concurrency
1. **Scope:** Filesystem JSON ledger and state-dir persistence check (`tests/verify-package.mjs`, `scripts/execution-guard-hook.mjs`).
2. **Coverage:** Complete.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** None identified within reviewed scope.
5. **P3 (low priority):** None identified within reviewed scope.
6. **Verification:** Confirmed no SQL/database engine exists; JSON state files are governed under `RUN` and `SVC`.
7. **Category Verdict:** Not applicable (`Agy-Context-Saver` uses filesystem JSON state only).

### `SCRIPT` - Scripts, Evaluation, and Developer Tooling
1. **Scope:** Hook script delegation to `rtk hook antigravity` and release/package scripts (`scripts/release-preflight.mjs`, `scripts/install-register.mjs`).
2. **Coverage:** Complete.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** None identified within reviewed scope (`parseRtkReadCommand` and shim parity tracked in `RUN` and `TEST`).
5. **P3 (low priority):** None identified within reviewed scope.
6. **Verification:** Executed `npm run preflight`, `npm run verify:package`, `agy-context setup`, and `agy-context status --json`.
7. **Category Verdict:** No findings within reviewed scope.

### `TEST` - Tests and CI
1. **Scope:** `tests/helpers/hermetic-fixture.mjs`, `tests/test-output-governance.mjs`, `tests/test-rtk-integration.mjs`, `tests/test-hook.mjs`, and `.github/workflows/ci-matrix.yml` / `.github/workflows/docs.yml`.
2. **Coverage:** Complete locally across Linux + live `rtk 1.1.0`; remote macOS/Windows/Zensical CI pending re-run on follow-up commit.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** `PR9-TEST-001` (Closed). See Section 5.
5. **P3 (low priority):** None identified within reviewed scope.
6. **Verification:** All 12 `npm test` suites executed cleanly after final edit, including explicit non-`forceShim` live `rtk 1.1.0` contract tests in `tests/test-rtk-integration.mjs`.
7. **Category Verdict:** Incomplete pending remote macOS/Windows and Zensical CI completion on follow-up commit (no open test defects).

### `DEP` - Dependencies, Packaging, and Configuration
1. **Scope:** `package.json`, `plugin.json`, `hooks.json`, `tests/verify-package.mjs`, and `docs/publishing.md`.
2. **Coverage:** Complete.
3. **P1 (high priority):** None identified within reviewed scope.
4. **P2 (medium priority):** None identified within reviewed scope.
5. **P3 (low priority):** Cross-referenced `PR9-DOC-004` (`docs/publishing.md` package file count/tag example, tracked in `DOC`; Closed).
6. **Verification:** `npm run preflight` passed (`rtk >= 1.1.0`), `npm run verify:package` verified tarball boundary cleanly, and `agy plugin validate --strict --json` returned `findings: []`.
7. **Category Verdict:** No findings within reviewed scope.

---

## 5. Consolidated Atomic Finding Records (`1 ID = 1 Row / Record`)

### `P1` and `P2` Records (10-Field Format)

#### `PR9-RUN-001` - Multi-operand `cat` / `rtk read` piggybacking bypasses Check 1, Check 2, and Check 4 (`UNKNOWN`) | `P1` | Closed
- **Contract provenance:** [LEDGER.md](../plans/LEDGER.md) `L38` / `L39` / `L55` internal state containment and `Check 2` `RUNNING` polling backoff (`LH-02`, `LH-03`).
- **Source evidence:** `scripts/execution-guard-hook.mjs#L450-L506` (`matchTaskLogToken`, `extractTaskLogMatches`), `#L3666-L3748` (`parseRtkReadCommand`), `#L4732-L4768` (`Check 2` and `Check 1`), `#L4819-L4861` (`Check 3` and `Check 4`).
- **Trigger:** `cat tasks/task-done.log ~/.local/state/agy-context-saver/transcript-access.json`, `cat .system_generated/steps/1/output.txt .system_generated/logs/transcript.jsonl`, `cat tasks/task-done.log tasks/task-running.log`, `cat tasks/task-done.log tasks/task-unknown.log`, or `rtk read tasks/nonexistent.log <protected>`.
- **Expected / actual:** Expected internal reads to allow strictly one spillover or completed task log and still enforce `Check 1`, `Check 2`, and `Check 4` (`UNKNOWN`) on all operands; actually `dba51fb` skipped `Check 1` globally whenever any spillover or task match existed and checked only the first `tasks/*.log` match.
- **Impact:** Allowed `L6` transcript/state-dir reads, `RUNNING` backoff bypass, and `UNKNOWN` task-log `!isExplicitRtkRead` bypass via piggybacked second operands.
- **Required remediation:** Parse all `rtk read` operands via `parseRtkReadCommand()`, evaluate `getTaskState()` across every matched task log (`Check 2` before `Check 1`), strip at most one non-mixed token per single-segment command before `Check 1`, and enforce strictly 1 valid operand matching spillover or task log after RTK rewrite.
- **Acceptance evidence:** Added 7 multi-operand smuggling assertions + reverse/forward `cat` running-log assertions in `tests/test-output-governance.mjs` and `tests/test-rtk-integration.mjs`; all pass after final edit.
- **Root cause / related IDs:** Single-match helpers paired with global `Check 1` bypass (`PR9-RUN-003`, `PR9-TEST-001`).
- **Closure:** Remediated on `fix/v2.0.4-rtk-read-parity` follow-up commit; re-verified locally (`npm test`, `test-output-governance.mjs`, `test-rtk-integration.mjs`); pending Neon High `reviewer` & remote CI confirmation.

#### `PR9-RUN-002` - Bidirectional bounce loop on `> 45 KiB` completed task logs and 1-hop bounce on `> 45 KiB` spillovers | `P2` | Closed
- **Contract provenance:** Tier 3 task-log vs. spillover separation (`rules/AGENTS.md#L43`, [tools.md](../tools.md#L18), [LEDGER.md](../plans/LEDGER.md) `L55`).
- **Source evidence:** `scripts/execution-guard-hook.mjs#L701-L711` (`isOversizedInternalTarget`), `#L4874-L4882` (`> 45 KiB` `rtk read` denial), `#L4965-L4971` (`2a`), `#L4981-L4989` (`2b`).
- **Trigger:** Calling `cat` on a `> 45 KiB` completed task log followed by `read_file <= 150` lines (per the old prompt hint), or calling `read_file` on a `> 45 KiB` spillover or completed task log and retrying the bare suggested `rtk read <target>`.
- **Expected / actual:** Expected `> 45 KiB` task-log denial never to suggest `read_file`, and `2a`/`2b` denials on `> 45 KiB` targets to include `--head-lines 150` / `--tail-lines 150`; actually `L4620` suggested `read_file` for task logs and `2a`/`2b` suggested bare `rtk read`.
- **Impact:** Caused avoidable agent retry turns and denial loops.
- **Required remediation:** Emit `(or use bounded 'read_file' <= 150 lines)` at `L4876` only when `isSpillover && !taskMatch`, and check `isOversizedInternalTarget()` in `2a`/`2b` to suggest `'rtk read --tail-lines 150 <target>' (or '--head-lines 150')` when `> 45 KiB`.
- **Acceptance evidence:** Added bounce-loop negative/positive assertions in `tests/test-output-governance.mjs` verifying no `read_file` mention on `> 45 KiB` task-log denials and `--head-lines 150` / `--tail-lines 150` presence on `2a`/`2b` `> 45 KiB` denials.
- **Root cause / related IDs:** Shared static message strings ignoring `isSpillover` vs. `taskMatch` and target byte size (`PR9-TEST-001`).
- **Closure:** Remediated on `fix/v2.0.4-rtk-read-parity` follow-up commit; locally verified; pending Neon High `reviewer` & CI recheck.

#### `PR9-RUN-003` - `hasLineBoundFlag` raw regex bypassed by `-- -m`, falsely denies `-m150`, and lacks a `<= 150` numeric cap | `P2` | Closed
- **Contract provenance:** `ACS-HOOK-GREP-CLAMP` `> 45 KiB` anti-spillover invariant and `MAX_SAFE_SLICE_LINES = 150` bound.
- **Source evidence:** `scripts/execution-guard-hook.mjs#L49-L51` (hoisted `MAX_SAFE_SLICE_LINES = 150`), `#L3666-L3748` (`parseRtkReadCommand`), `#L4864` (`!parsedEff.hasSafeLineBound`).
- **Trigger:** `rtk read <big> -- -m`, `rtk read --head-lines 999999 <big>`, `rtk read --head-lines 0 <big>`, or valid `rtk read -m150 <big>`.
- **Expected / actual:** Expected `--` to terminate flag parsing, `-m150` / `=150` to satisfy bounds, and line counts outside `1..150` to be denied on `> 45 KiB`; actually raw regex matched `-- -m`, allowed `999999`, and rejected `-m150`.
- **Impact:** Allowed unbounded `> 45 KiB` spillover/task-log output while blocking valid `rtk read -m150`.
- **Required remediation:** Parse `tokenizeShellWords(cmd)` in `parseRtkReadCommand()` stopping flags at `--`, supporting `--head-lines`/`--tail-lines`/`--max-lines`/`-m` with `=N` and `-mN`, and requiring `1 <= n <= MAX_SAFE_SLICE_LINES` with zero invalid/oversized line flags.
- **Acceptance evidence:** Added `-- -m`, `--head-lines 999999`, `--head-lines 0`, `head -n 999999`, `--head-lines 150 --tail-lines 999999` (all denied), and `-m150`, `--head-lines=150` (allowed) in `tests/test-output-governance.mjs` + `tests/test-rtk-integration.mjs` (plus live host `rtk read -m150` execution).
- **Root cause / related IDs:** Raw regex line-flag scan without token/range validation (`PR9-RUN-001`, `PR9-TEST-001`).
- **Closure:** Remediated on `fix/v2.0.4-rtk-read-parity` follow-up commit; locally verified; pending Neon High `reviewer` & CI recheck.

#### `PR9-RUN-004` - `resolveTaskPaths()` and `resolveInternalReadStatPaths()` lack `~/` expansion and cross-session relative task lookup | `P2` | Closed
- **Contract provenance:** Cross-session `RUNNING` backoff and `> 45 KiB` containment invariants (`L38`, `L55`).
- **Source evidence:** `scripts/execution-guard-hook.mjs#L396-L405` (`expandLeadingTilde`), `#L602-L711` (`resolveTaskPaths`, `resolveInternalReadStatPaths`).
- **Trigger:** `rtk read ~/.gemini/antigravity/brain/<otherConv>/.system_generated/tasks/task-running.log`, `cat ~/.gemini/.../task-big.log`, or `rtk read <otherConv>/.system_generated/tasks/task-running.log`.
- **Expected / actual:** Expected `~/` expansion against `getProfileHomeDir()` and `<otherConv>/.system_generated/tasks/...` resolution across `getBrainDirs()`; actually `resolveTaskPaths()` missed both (`taskState = "UNKNOWN"`), bypassing `Check 2` `RUNNING` backoff, and `resolveInternalReadStatPaths()` missed `~/`.
- **Impact:** Cross-session `~/` or relative `<otherConv>` task-log paths bypassed `Check 2` and `> 45 KiB` size checks.
- **Required remediation:** Add shared `expandLeadingTilde()` using `getProfileHomeDir()` in both helpers and resolve relative `<otherConvId>/.system_generated/tasks/...` against `getBrainDirs()` inside `resolveTaskPaths()`.
- **Acceptance evidence:** Added `tildeRunOut`, `tildeBigCat` (`global` caller), and `relCrossRun` assertions in `tests/test-output-governance.mjs` verifying `actively RUNNING` and `--head-lines 150` denials.
- **Root cause / related IDs:** Asymmetric path normalization across `resolveTaskPaths()` and `resolveInternalReadStatPaths()` (`PR9-RUN-005`, `PR9-RUN-006`).
- **Closure:** Remediated on `fix/v2.0.4-rtk-read-parity` follow-up commit; locally verified; pending Neon High `reviewer` & CI recheck.

#### `PR9-TEST-001` - `createRtkShim` diverges from live `rtk 1.1.0` and key regression cases lack coverage | `P2` | Closed
- **Contract provenance:** Cross-platform `rtk >= 1.1.0` test parity (`L37`, `L55`).
- **Source evidence:** `tests/helpers/hermetic-fixture.mjs#L61-L66`, `tests/test-output-governance.mjs#L281-L490`, `tests/test-rtk-integration.mjs#L112-L176`, `tests/test-hook.mjs#L334-L339`.
- **Trigger:** Running `forceShim: true` tests with `type`, `Get-Content`, bare `tail`, quoted `head`/`tail`, or Windows backslash `head`/`tail`, and omitting tests for `UNKNOWN` logs, multi-operand smuggling, line-bound edges, bounce suppression, and `~/`/cross-session/space paths.
- **Expected / actual:** Expected hermetic shim and tests to mirror actual `rtk 1.1.0 hook antigravity` rewrite boundaries and exercise all remediated code paths; actually the old shim over-rewrote unsupported forms while missing `head <file>`, `-<N>`, and `--lines=<N>`.
- **Impact:** Masked real-world `Check 3` / `Check 4` denials on quoted/backslash/bare-`tail` invocations and left `PR9-RUN-001`..`006` untested.
- **Required remediation:** Align `createRtkShim` strictly with verified `rtk 1.1.0` behavior (`cat` non-flag / `-n` only, excluding `-A`, `-b`, `-e`, `-E`, `-s`, `-t`, `-T`, `-u`, `-v`, `--`; single unquoted forward-slash `head` including bare/`-N`/`-n N`/`--lines=N`; `tail` requiring count) and add full live-host + hermetic test coverage.
- **Acceptance evidence:** `node tests/test-output-governance.mjs`, `node tests/test-rtk-integration.mjs` (running against host `rtk 1.1.0`), `node tests/test-hook.mjs`, and full 12-suite `npm test` all pass.
- **Root cause / related IDs:** Pre-existing broad regexes in test shim plus newly discovered runtime cases (`PR9-RUN-001`..`008`, `PR9-DOC-001`).
- **Closure:** Verified Closed on `6531c48` (`GH CI 7/7 success`, Neon High `APPROVE`), with final `cat -n`/`-A`/`-b`/`-s` shim parity & `PR9-RUN-008` regression tests added in the follow-up commit on `fix/v2.0.4-rtk-read-parity`.

#### `PR9-DOC-001` - Tier 3 and intro docs overstate unconditional `cat` / `head` / `tail` auto-rewriting under `rtk 1.1.0` | `P2` | Closed
- **Contract provenance:** Documentation accuracy invariant (`L55`).
- **Source evidence:** `rules/AGENTS.md#L43`, `skills/context-governance/SKILL.md#L30`, [architecture.md](../architecture.md#L14), [architecture.md](../architecture.md#L39), [governance.md](../governance.md#L33), [governance.md](../governance.md#L41), [tools.md](../tools.md#L18).
- **Trigger:** Following unqualified `"cat, head, and tail auto-rewrite via rtk"` with bare `tail <path>`, quoted `head -n 150 "<path>"` / `tail -n 150 "<path>"`, Windows backslash paths, or env-prefixed calls.
- **Expected / actual:** Expected docs to reflect actual `rtk 1.1.0` behavior; actually host `rtk 1.1.0` only auto-rewrites `cat` (non-flag / `-n`) and single unquoted forward-slash `head` / counted `tail -n`/`-<N>`/`--lines=<N>`, leaving bare `tail`, quoted/spaced `head`/`tail`, and backslash `head`/`tail` unrewritten (denied at Check 3/4).
- **Impact:** Agents following unqualified docs on quoted, Windows, or bare `tail` reads hit avoidable hook denials.
- **Required remediation:** Qualify all Tier 3 and intro bullets to state `cat` and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`, and instruct explicit `rtk read <path>` for bare `tail`, quoted/spaced paths, Windows backslash paths, and env-prefixed calls.
- **Acceptance evidence:** Source reconciliation across all 5 files paired directly with live `rtk 1.1.0 hook antigravity` probe outputs; zero prose em dashes (`NO_EM_DASHES`).
- **Root cause / related IDs:** Assumed symmetric `rtk` rewrite rules prior to matrix probing (`PR9-TEST-001`).
- **Closure:** Verified Closed on `6531c48` (`Documentation/build` `44425344724` `success` and Neon High `APPROVE`).

---

### `P3` Findings Table (`1 ID = 1 Row`)

| ID | Wave / Session | Cat | Status | Source | Defect / Proposal | Disposition / Fix | Verification & SHA |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `PR9-RUN-005` | Pass 1 + Pass 2 | `RUN` | Closed | `scripts/execution-guard-hook.mjs#L450-L506`, `#L4975` | `getTaskLogMatch` regex `[^\s"']*` truncated quoted paths containing spaces (failing closed on Windows/macOS spaced profiles). | Added `matchTaskLogToken()`, shell-word + quoted-span scanning in `extractTaskLogMatches()`, and direct `matchTaskLogToken(target)` in `2b` & `resolveInternalReadStatPaths()`. | Verified Closed at `6531c48` (`GH CI 7/7 success`, Neon High `APPROVE`). |
| `PR9-RUN-006` | Pass 1 + Pass 2 | `RUN` | Closed | `scripts/execution-guard-hook.mjs#L582-L651` | `resolveTaskPaths()` hardcoded `task-${match.id}.log` even for non-`task-`-prefixed logs like `tasks/custom.log`. | Added `pickTaskFilesInSysDir()` checking exact literal basename (`custom.log`) first when present before falling back to `task-<id>.log`. | Verified Closed at `6531c48` (`GH CI 7/7 success`, Neon High `APPROVE`). |
| `PR9-RUN-008` | Session 6 (`[LOW]`) | `RUN` | Closed | `scripts/execution-guard-hook.mjs#L600-L693` | Leading `./` in `./<otherConv>/.system_generated/tasks/...` or `cwd = brain/` fell back to caller's `convId` in `resolveTaskPaths()` / `resolveInternalReadStatPaths()`. | Added `stripLeadingDotSlash()` normalization in both helpers plus verified `.system_generated/tasks/` `resolveHookPath()` handling in `resolveTaskPaths()`. | Regression tests added in `tests/test-output-governance.mjs` from `os.tmpdir()` and `tempBrainDir` (`npm test` 12/12). |
| `PR9-DOC-002` | Pass 2 (`LOW-2`) | `DOC` | Closed | `scripts/execution-guard-hook.mjs#L5079-L5085`, `rules/AGENTS.md#L43`, `SKILL.md#L30`, [tools.md](../tools.md#L18), [governance.md](../governance.md#L40) | `read_many_files` denial suggested bare `rtk read <file>` for multi-file workspace reads while docs prohibit `rtk read` on editable workspace code. | Updated `read_many_files` denial to steer editable workspace code to bounded `read_file` (`<= 150` lines) and retain `rtk read <file>` for read-only logs/spillovers; synced `AGENTS.md`, `SKILL.md`, `docs/*`, and `test-hook.mjs#L334-L339`. | Verified Closed at `6531c48` (`GH CI 7/7 success`, Neon High `APPROVE`). |
| `PR9-DOC-003` | Pass 1 + Pass 2 | `DOC` | Closed | `CHANGELOG.md#L16`, [LEDGER.md](../plans/LEDGER.md#L90) | `CHANGELOG.md` omitted new test/doc files and `L55` was marked `done` prematurely while open in PR #9. | Expanded `CHANGELOG.md#L16` file/change coverage cleanly and updated `L55` status to `in PR 9` per [LEDGER.md](../plans/LEDGER.md#L23). | Verified Closed (`release-preflight.mjs` passes; `L55` transitions to `done` upon PR #9 merge). |
| `PR9-DOC-004` | Pass 1 (`LOW`) | `DOC` | Closed | [publishing.md](../publishing.md#L70), `#L85-L86` | Pre-existing drift: cited `33` package files and `v2.0.2` release tag example. | Updated to `35` files (reflecting `34` required baseline files plus this `docs/reviews/` report) and `v2.0.4` release example. | Verified Closed (`npm run verify:package` reports `35 files`, Neon High `APPROVE`). |
| `PR9-DOC-005` | Pass 1 (`LOW`) | `DOC` | Closed | [architecture.md](../architecture.md#L32) | Pre-existing drift: listed reverted implicit `wc`, `ls`, and `diff` rewrites while omitting `grep` (`scripts/execution-guard-hook.mjs#L3942`). | Added `grep` (`Implicit wc, ls, diff, and grep rewrites...`). | Verified Closed at `6531c48` (Neon High `APPROVE`). |
| `PR9-DOC-006` | Pass 1 (`LOW`) | `SKILL` | Closed | `rules/AGENTS.md#L18`, `skills/context-governance/SKILL.md#L108` | Pre-existing drift: watchdog example showed `TimerCondition="task-X"` whereas live `schedule` requires `"<convId>/task-X"`. | Updated example in both files to `TimerCondition="<convId>/task-X"`. | Verified Closed at `6531c48` (Neon High `APPROVE`). |

*(Note: `PR9-RUN-007` is settled in Section 8 below as Closed (By Design) per Standard `1.4.0` Section 5.)*

---

## 6. Cross-Category Root Causes, Verification Record & Remaining Gaps

- **Cross-Category Root Cause:** Relaxing `Check 4` to accept post-rewrite `rtk read` exposed asymmetric assumptions across the hook and tests: `Check 1` skipped protected-state scanning globally whenever any single spillover/task token existed, `hasLineBoundFlag` used a raw regex instead of token-level parsing, `resolveTaskPaths()` omitted `~/`, leading `./`, `cwd`-relative brain lookups, and relative cross-session expansion already partially present in `resolveInternalReadStatPaths()`, and `createRtkShim` drifted from actual `rtk 1.1.0` rules. Consolidating token/path helpers (`parseRtkReadCommand()`, `extractTaskLogMatches()`, `expandLeadingTilde()`, `stripLeadingDotSlash()`, `isOversizedInternalTarget()`) resolved both code and doc/test drift consistently.
- **Verification Executed (Local & CI):**
  - On `6531c48e467aa711a155e5e3381d8bb7fb5ef429`: GitHub Actions CI `7/7` `SUCCESS` (`Release-readiness CI` `44425344726` across Node 22 & 24 on `ubuntu-latest`, `macos-latest`, and `windows-latest`; `Documentation/build` `44425344724`; `deploy` skipped on PR), and Session #6 swarm `reviewer` (`Gemini 4 Neon (High)`, board `#6`) returned **APPROVE**.
  - Post-`6531c48` final polish (`PR9-RUN-008` + `[INFO]` #1/#2): `agy-context setup`, `agy-context status --json` (`mirroredHookStale: false`, `isComplete: true`), `npm test` (`12/12` suites including live host `rtk 1.1.0`), `npm run preflight`, `npm run verify:package` (`35 files`), `agy plugin validate --strict --json` (`findings: []`), `git diff --check`, and Markdown zero-em-dash scan (`NO_EM_DASHES`).
- **Remaining Gaps:** Confirm remote GitHub Actions CI and final `Gemini 4 Neon (High)` recheck on the final pushed polish head before merging PR #9 into `main` and tagging `v2.0.4`.

---

## 7. Overall Disposition & Finding Closure Summary

- **Pre-Remediation Verdict (`dba51fb`):** Changes required (`1` P1, `5` P2, `8` P3 surfaced across Passes 1–2).
- **Remediation Verdict (`6531c48`):** Approved (`GH CI 7/7 success`, `Gemini 4 Neon (High)` `seq #6` `APPROVE`, surfaced `PR9-RUN-008` LOW + 2 INFO notes).
- **Current Disposition (`PR9-RUN-008` + INFO follow-up on `fix/v2.0.4-rtk-read-parity`):** All 14 remediated IDs (`PR9-RUN-001`..`006`, `PR9-RUN-008`, `PR9-TEST-001`, `PR9-DOC-001`..`006`) Closed, `PR9-RUN-007` settled in Section 8 (`Closed (By Design)`), 0 open defects locally; awaiting remote CI green check on the final pushed head before merging PR #9 (`L55` -> `done`) and tagging `v2.0.4`.

| ID | Pre-Remediation Status | Current Status | Closure / Verification Anchor |
| :--- | :--- | :--- | :--- |
| `PR9-RUN-001` | Open (Pre-Remediation) | Closed | Verified `6531c48` (`GH CI 7/7`, Neon High `APPROVE`) |
| `PR9-RUN-002` | Open (Pre-Remediation) | Closed | Verified `6531c48` (`GH CI 7/7`, Neon High `APPROVE`) |
| `PR9-RUN-003` | Open (Pre-Remediation) | Closed | Verified `6531c48` (`GH CI 7/7`, Neon High `APPROVE`) |
| `PR9-RUN-004` | Open (Pre-Remediation) | Closed | Verified `6531c48` (`GH CI 7/7`, Neon High `APPROVE`) |
| `PR9-RUN-005` | Open (Pre-Remediation) | Closed | Verified `6531c48` (`GH CI 7/7`, Neon High `APPROVE`) |
| `PR9-RUN-006` | Open (Pre-Remediation) | Closed | Verified `6531c48` (`GH CI 7/7`, Neon High `APPROVE`) |
| `PR9-RUN-007` | Open (Pre-Remediation) | See Section 8 (`Closed (By Design)`) | `tests/test-output-governance.mjs` (`FOO=1 cat ...` denied) |
| `PR9-RUN-008` | Surfaced in Session 6 (`[LOW]`) | Closed | `tests/test-output-governance.mjs` (`./<otherConv>` from `os.tmpdir()` & `tempBrainDir`) |
| `PR9-TEST-001` | Open (Pre-Remediation) | Closed | `tests/helpers/hermetic-fixture.mjs`, `npm test` (`12/12`) |
| `PR9-DOC-001` | Open (Pre-Remediation) | Closed | Source reconciliation + live `rtk 1.1.0` probes |
| `PR9-DOC-002` | Open (Pre-Remediation) | Closed | `scripts/execution-guard-hook.mjs#L5079-L5085`, `tests/test-hook.mjs#L334-L339` |
| `PR9-DOC-003` | Open (Pre-Remediation) | Closed | `CHANGELOG.md#L16`, `docs/plans/LEDGER.md#L90` (`in PR 9`) |
| `PR9-DOC-004` | Open (Pre-Remediation) | Closed | `docs/publishing.md#L70`, `#L85-L86` (`35` files, `v2.0.4`) |
| `PR9-DOC-005` | Open (Pre-Remediation) | Closed | `docs/architecture.md#L32` |
| `PR9-DOC-006` | Open (Pre-Remediation) | Closed | `rules/AGENTS.md#L18`, `skills/context-governance/SKILL.md#L108` |

---

## 8. Post-Remediation Residuals & Deferred Dispositions

| ID | Wave / Session | Cat | Status | Source | Defect / Proposal | Disposition / Fix | Verification & SHA |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `PR9-RUN-007` | Pass 1 + Pass 2 | `RUN` | Closed (By Design) | `scripts/execution-guard-hook.mjs#L3674-L3677`, `tests/test-output-governance.mjs#L325-L341` | `FOO=1 cat ...` -> `FOO=1 rtk read ...` is rejected because `parseRtkReadCommand()` requires `tokens[0] === "rtk"` and `tokens[1] === "read"`. | Intentionally kept fail-closed to eliminate `LD_PRELOAD` / `HOME` / `PATH` / `env -S` env-prefix bypasses on internal log reads; docs (`AGENTS.md#L43`, `SKILL.md#L30`, [governance.md](../governance.md#L33), [tools.md](../tools.md#L18)) instruct explicit `rtk read <path>` without env prefixes. | `tests/test-output-governance.mjs` verifies both `FOO=1 cat tasks/task-live-1.log` and `AGY_BRAIN_DIR=/tmp cat tasks/task-live-1.log` deny. |
