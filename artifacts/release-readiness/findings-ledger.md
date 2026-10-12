# Release Readiness Findings Ledger

> **Initial SHA**: `e83b6c0d19b67401d7f7d162d72aa73f12608e3c`  
> **Status**: **Phase B Active (Remediation)**  
> **Traceability Mandate**: Every finding must trace from Provenance (P1–P4) $\to$ Source Evidence $\to$ Assigned Brief $\to$ Acceptance Test $\to$ Independent Post-Check.

---

## 1. Master Findings Table

| ID | Title | Provenance | Source Evidence | Severity | Gate | Assigned Brief | Test Added / Acceptance Test | Post-Check Verdict |
| :--- | :--- | :---: | :--- | :---: | :---: | :---: | :--- | :---: |
| **R-01** | `--check` falls through to mutating installation on clean profile | `P1, P2, P4` | `scripts/install-register.mjs:134-180` | **CRITICAL** | Gate 1 | **FIX-1** | `tests/test-check-only-readonly.mjs` | PENDING |
| **R-02** | Malformed JSON in hooks/mcp configs fails open and clobbers files | `P1, P2, P4` | `scripts/install-register.mjs:220-270` | **CRITICAL** | Gate 1 | **FIX-1** | `tests/test-malformed-config-preservation.mjs` | PENDING |
| **R-03a** | Missing SHA-256 checksum verification on RTK binary archive download | `P2, P3` | `scripts/provision-rtk.mjs:64-74` | **CRITICAL** | Gate 2 | **FIX-3** | In-code hash lookup + digest verification | PENDING |
| **R-03b** | Unvalidated RTK version acceptance on PATH (version drift) | `P2, P4` | `scripts/provision-rtk.mjs:32-47` | **HIGH** | Gate 2 | **FIX-3** | Version range validation in `findExistingRtk` | PENDING |
| **R-03c** | Installer fails open on RTK download/extraction failure | `P1, P2` | `scripts/install-register.mjs:169-175` | **HIGH** | Gate 2 | **FIX-1 / FIX-3** | Strict fail-closed on RTK failure without `--allow-degraded` | PENDING |
| **R-04** | Missing package metadata (`repository`, `homepage`, `bugs`, `engines`) | `P2, P4` | `package.json:1-42` | **HIGH** | Gate 3 | **FIX-2** | `release-preflight.mjs` metadata check | PENDING |
| **R-07** | Zero automated CI test workflows in `.github/workflows/` | `P2` | `.github/workflows/` | **HIGH** | Gate 3 | **FIX-2** | `.github/workflows/ci-matrix.yml` across OS matrix | PENDING |
| **R-08** | Missing community health policies (`SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`) | `P2, P3` | Root repository | **MEDIUM** | Gate 4 | **FIX-4** | Verified policy documents in root | PENDING |
| **R-09a** | Unsupported JSON shapes (`null`, `[]`) crash or silently drop hook registrations | `P2, P4` | `scripts/install-register.mjs:238-273` | **HIGH** | Gate 1 | **FIX-1** | Object-shape type guards in config loaders | PENDING |
| **R-09b** | Invalid GitHub Actions versions (`@v7`) in release package workflow templates | `P2` | Workflow templates | **CRITICAL** | Gate 3 | **FIX-2** | Pinned `@v4` actions in CI workflows | PENDING |
| **R-10a** | Suites 6 & 7 violate test isolation and mutate host profile | `P2, P4` | `tests/test-installed-verification.mjs`, `test-lifecycle-rollback.mjs` | **HIGH** | Gate 3 | **FIX-1 / FIX-2** | Isolate to temporary `AGY_CONFIG_DIR` root | PENDING |
| **R-10b** | Suite 4 E2E brittle branch assertion on `rtk git status` | `P2, P4` | `tests/test-e2e-probes.mjs:140` | **HIGH** | Gate 3 | **FIX-2** | Assertion decoupling from specific branch name | PENDING |
| **R-11** | PowerShell installer hardcodes paths and fails to forward CLI arguments | `P2` | `install.ps1:17-38` | **MEDIUM** | Gate 1 | **FIX-1** | Dynamic Node resolution and `$args` forwarding | PENDING |
| **R-12** | `--restore-backups` without `uninstall` falls through to install | `P2, P4` | `scripts/install-register.mjs:650-658` | **MEDIUM** | Gate 1 | **FIX-1** | Explicit CLI action router | PENDING |
| **R-13** | Release workflow missing npm provenance attestation | `P2, P3` | Release workflow | **MEDIUM** | Gate 4 | **FIX-2** | `--provenance` flag in `npm publish` job | PENDING |
| **R-05** | Documentation test suite count synchronization (8 $\to$ 10 once regression suites added) | `P2` | `README.md`, `docs/publishing.md` | **LOW** | Gate 3 | **FIX-4** | Synchronized 10-suite list in README and publishing docs | PENDING |
