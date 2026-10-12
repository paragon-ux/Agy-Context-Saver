# Release Readiness Findings Ledger

> **Initial SHA**: `e83b6c0d19b67401d7f7d162d72aa73f12608e3c`
> **PR #1 SHA**: `2ad5112446ceaeecd249ced47209d9a7c8121eed`
> **Status**: **Phase C Complete (100% Verified by POST-1, POST-2, POST-D1, and POST-D2)**
> **Traceability Mandate**: Every finding must trace from Provenance $\to$ Source Evidence $\to$ Assigned Brief $\to$ Acceptance Test $\to$ Independent Post-Check.

---

## 1. PR #1 Master Findings Table (`R-01` through `R-13`)

| ID | Title | Provenance | Source Evidence | Severity | Gate | Assigned Brief | Test Added / Acceptance Test | Post-Check Verdict |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :--- | :---: |
| **R-01** | `--check` falls through to mutating installation on clean profile | `P1, P2, P4` | `scripts/install-register.mjs:134-180` | **CRITICAL** | Gate 1 | **FIX-1** | `tests/test-check-only-readonly.mjs` | **PASS** |
| **R-02** | Malformed JSON in hooks/mcp configs fails open and clobbers files | `P1, P2, P4` | `scripts/install-register.mjs:220-270` | **CRITICAL** | Gate 1 | **FIX-1** | `tests/test-malformed-config-preservation.mjs` | **PASS** |
| **R-03a** | Missing SHA-256 checksum verification on RTK binary archive download | `P2, P3` | `scripts/provision-rtk.mjs:64-74` | **CRITICAL** | Gate 2 | **FIX-3** | In-code hash lookup + digest verification | **PASS** |
| **R-03b** | Unvalidated RTK version acceptance on PATH (version drift) | `P2, P4` | `scripts/provision-rtk.mjs:32-47` | **HIGH** | Gate 2 | **FIX-3** | Version range validation in `findExistingRtk` | **PASS** |
| **R-03c** | Installer fails open on RTK download/extraction failure | `P1, P2` | `scripts/install-register.mjs:169-175` | **HIGH** | Gate 2 | **FIX-1 / FIX-3** | Strict fail-closed on RTK failure without `--allow-degraded` | **PASS** |
| **R-04** | Missing package metadata (`repository`, `homepage`, `bugs`, `engines`) | `P2, P4` | `package.json:1-42` | **HIGH** | Gate 3 | **FIX-2** | `release-preflight.mjs` metadata check | **PASS** |
| **R-07** | Zero automated CI test workflows in `.github/workflows/` | `P2` | `.github/workflows/` | **HIGH** | Gate 3 | **FIX-2** | `.github/workflows/ci-matrix.yml` across OS matrix | **PASS** |
| **R-08** | Missing community health policies (`SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`) | `P2, P3` | Root repository | **MEDIUM** | Gate 4 | **FIX-4** | Verified policy documents in root | **PASS** |
| **R-09a** | Unsupported JSON shapes (`null`, `[]`) crash or silently drop hook registrations | `P2, P4` | `scripts/install-register.mjs:238-273` | **HIGH** | Gate 1 | **FIX-1** | Object-shape type guards in config loaders | **PASS** |
| **R-09b** | Invalid GitHub Actions versions (`@v7`) in release package workflow templates | `P2` | Workflow templates | **CRITICAL** | Gate 3 | **FIX-2** | Pinned `@v4` actions in CI workflows | **PASS** |
| **R-10a** | Suites 6 & 7 violate test isolation and mutate host profile | `P2, P4` | `tests/test-installed-verification.mjs`, `test-lifecycle-rollback.mjs` | **HIGH** | Gate 3 | **FIX-1 / FIX-2** | Isolate to temporary `AGY_TEST_PROFILE_DIR` root | **PASS** |
| **R-10b** | Suite 4 E2E brittle branch assertion on `rtk git status` | `P2, P4` | `tests/test-e2e-probes.mjs:140` | **HIGH** | Gate 3 | **FIX-2** | Assertion decoupling from specific branch name | **PASS** |
| **R-11** | PowerShell installer hardcodes paths and fails to forward CLI arguments | `P2` | `install.ps1:17-38` | **MEDIUM** | Gate 1 | **FIX-1** | Dynamic Node resolution and `$args` forwarding | **PASS** |
| **R-12** | `--restore-backups` without `uninstall` falls through to install | `P2, P4` | `scripts/install-register.mjs:650-658` | **MEDIUM** | Gate 1 | **FIX-1** | Explicit CLI action router | **PASS** |
| **R-13** | Release workflow missing npm provenance attestation | `P2, P3` | Release workflow | **MEDIUM** | Gate 4 | **FIX-2** | `--provenance` flag in `npm publish` job | **PASS** |
| **R-05** | Documentation test suite count synchronization (8 $\to$ 10 once regression suites added) | `P2` | `README.md`, `docs/publishing.md` | **LOW** | Gate 3 | **FIX-4** | Synchronized 10-suite list in README and publishing docs | **PASS** |

---

## 2. PR #2 Stacked Findings Table — Devin Review (`D-01` through `D-09`)

| ID | Title | Provenance | Source Evidence | Severity | Gate | Assigned Brief | Test Added / Acceptance Test | Post-Check Verdict |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :--- | :---: |
| **D-01** | RTK version checks bypassed by `AGY_ALLOW_ANY_RTK=1` environment variable | `Devin PR#1, PRE-D2` | `scripts/provision-rtk.mjs:63-64, 72-73` | **HIGH (Vuln)** | Gate 2 | **FIX-D2** | Remove `AGY_ALLOW_ANY_RTK` bypass; verify strict semver rejection in `test-lifecycle-rollback.mjs` | **PASS (POST-D2)** |
| **D-02** | Clean CI runners fail `npm test` due to missing RTK, profile, and conversation fixtures | `Devin PR#1, PRE-D3` | `.github/workflows/ci-matrix.yml:41-42`, `tests/test-e2e-probes.mjs`, `tests/test-installed-verification.mjs`, `mcp/index.js:610,663` | **CRITICAL (Bug)** | Gate 3 | **FIX-D3** | Shared hermetic test bootstrap (`tests/helpers/hermetic-fixture.mjs`) + `AGY_TEST_PROFILE_DIR` support in `mcp/index.js` & hook | **PASS (POST-D2)** |
| **D-03** | Incompatible `PATH` RTK used by hook rewrites despite compatible local binary | `Devin PR#1, PRE-D2` | `scripts/provision-rtk.mjs:71-78`, `scripts/execution-guard-hook.mjs:287-296, 366-422` | **HIGH (Bug)** | Gate 2 | **FIX-D2** | Resolve compatible RTK (`resolveCompatibleRtk`) in hook; substitute local binary path in rewritten commands when `PATH` RTK is incompatible | **PASS (POST-D2)** |
| **D-04** | Failed Windows install overwrites shared `node.cmd` wrapper before preflight | `Devin PR#1, PRE-D1` | `install.ps1:6-52` | **HIGH (Bug)** | Gate 1 | **FIX-D1** | Run `install-register.mjs` first; gate wrapper creation on exit 0 & install-only mode; honor `AGY_TEST_PROFILE_DIR`; preserve foreign `node.cmd` | **PASS (POST-D1)** |
| **D-05** | `--check --restore-backups` executes destructive restore instead of read-only check | `Devin PR#1, PRE-D1` | `scripts/install-register.mjs:706-729`, `mcp/index.js:35-50` | **HIGH (Bug)** | Gate 1 | **FIX-D1** | Reject conflicting action flags (`--check` + `--restore-backups`/`--uninstall`) with exit 1; evaluate read-only flags first | **PASS (POST-D1)** |
| **D-06** | `--check` returns success before `parseAndValidateJsonConfig` validates existing JSON | `Devin PR#1, PRE-D1` | `scripts/install-register.mjs:168-195` | **HIGH (Bug)** | Gate 1 | **FIX-D1** | Hoist read-only `parseAndValidateJsonConfig` above `if (options.checkOnly)` so `--check` fails closed on malformed config | **PASS (POST-D1)** |
| **D-07** | `docs/installation.md` states Node `>=18.0.0`, conflicting with `package.json` `>=22` | `Devin PR#1, PRE-D2` | `docs/installation.md:7-10`, `package.json:26-28` | **LOW (Flag)** | Gate 4 | **FIX-D2** | Reconcile `docs/installation.md` to `Node.js >= 22.0.0` | **PASS (POST-D2)** |
| **D-08** | `docs/RTK-SUPPORT-MATRIX.md` describes version/checksum validation as unimplemented gaps | `Devin PR#1, PRE-D2` | `docs/RTK-SUPPORT-MATRIX.md:18-26`, `docs/INSTALLER-HARDENING.md:19-25` | **LOW (Flag)** | Gate 4 | **FIX-D2** | Update `docs/RTK-SUPPORT-MATRIX.md` & `docs/INSTALLER-HARDENING.md` to document active v1.6.0 policies | **PASS (POST-D2)** |
| **D-09** | Missing regression tests for incompatible RTK provisioning, upgrade idempotency, and junction fallback | `Devin PR#1, PRE-D1` | `tests/test-lifecycle-rollback.mjs:38-43`, `CONTRIBUTING.md:25-37` | **MEDIUM (Flag)** | Gate 1/3 | **FIX-D1** | Add explicit regression tests in `test-lifecycle-rollback.mjs`, `test-check-only-readonly.mjs`, and `test-malformed-config-preservation.mjs` | **PASS (POST-D1)** |
