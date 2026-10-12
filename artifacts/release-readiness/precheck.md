# Phase A: Preflight Verification & Audit Report

> **Generated**: 2026-10-12T14:55:00-04:00  
> **Commit SHA**: `e83b6c0d19b67401d7f7d162d72aa73f12608e3c`  
> **Branch**: `release/hardening-v1.6.0`  
> **Preflight Auditors**: PRE-1 (`ca5da609`), PRE-2 (`0b945d2c`), PRE-3 (`ee7f4de7`)  
> **Overall Preflight Gate Status**: **FAIL (Blockers Identified Across Gates 1, 2, and 3)**  

---

## 1. Executive Summary & Audit Reconcile

The independent, read-only Phase A preflight audit confirmed critical vulnerabilities and release-engineering gaps across installer safety, test isolation, supply-chain validation, and CI plumbing:

1. **Gate 1 (Installer Safety & Config Preservation) — FAIL**:
   - Running `--check` / `-c` on a fresh or uninstalled profile falls through into a full, mutating installation (writes directories, downloads binaries, creates symlinks, and alters JSON configs).
   - Malformed JSON in `hooks.json` or `mcp_config.json` fails open instead of failing closed: in-memory config resets to `{}` and permanently overwrites disk files with zero `.bak` backups created.
   - Non-object JSON shapes (`null`, `[]`) trigger unhandled `TypeError` exceptions or silently drop hook registrations.

2. **Gate 2 (RTK Supply Chain & Platform Support) — FAIL**:
   - `scripts/provision-rtk.mjs` downloads and extracts remote binary archives without verifying SHA-256 digests or cryptographic signatures.
   - Provisioning failure is treated as a non-fatal warning, allowing an execution governor to activate without the required `rtk` binary on PATH.
   - Zero CI test proof exists for claimed platforms (`.github/workflows/` only has `docs.yml`).

3. **Gate 3 (Tests, Packaging & Integration) — FAIL**:
   - Suite 4 (`tests/test-e2e-probes.mjs:140`) has a brittle branch assertion checking for `"main"` or `"package.json"` in git status, failing on clean feature/release branches.
   - Suites 6 & 7 directly mutate the host developer profile `~/.gemini/` and depend on proprietary `Waymark` fixtures, failing on clean/CI environments.
   - `package.json` lacks required repository, issue tracker, homepage, and engine metadata.
   - Release package workflow templates specify non-existent `actions/checkout@v7` and `actions/setup-node@v7`.

4. **Gate 4 (Release Trust & Operations) — PENDING**:
   - Missing `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md`.

---

## 2. Master Reconciled Preflight Findings Ledger

| ID | Title & Provenance | Target File(s) | Severity | Gate | Status | Assigned Remediation Brief |
| :--- | :--- | :--- | :---: | :---: | :---: | :--- |
| **R-01** | `--check` falls through to mutating install on clean profile (`P1, P2, P4`) | `scripts/install-register.mjs:134-180` | **CRITICAL** | Gate 1 | **CONFIRMED** | **FIX-1** |
| **R-02** | Malformed JSON in config clobbers user files with empty config (`P1, P2, P4`) | `scripts/install-register.mjs:220-270` | **CRITICAL** | Gate 1 | **CONFIRMED** | **FIX-1** |
| **R-03a** | Missing SHA-256 checksum verification on RTK binary archive download (`P2, P3`) | `scripts/provision-rtk.mjs:64-74` | **CRITICAL** | Gate 2 | **CONFIRMED** | **FIX-3** |
| **R-03b** | Unvalidated RTK version acceptance on PATH (`P2, P4`) | `scripts/provision-rtk.mjs:32-47` | **HIGH** | Gate 2 | **CONFIRMED** | **FIX-3** |
| **R-03c** | Installer fails open on RTK download/extraction failure (`P1, P2`) | `scripts/install-register.mjs:169-175` | **HIGH** | Gate 2 | **CONFIRMED** | **FIX-1 / FIX-3** |
| **R-04** | Missing package metadata (`repository`, `homepage`, `bugs`, `engines`) (`P2, P4`) | `package.json:1-42` | **HIGH** | Gate 3 | **CONFIRMED** | **FIX-2** |
| **R-07** | Zero automated CI test workflows in `.github/workflows/` (`P2`) | `.github/workflows/` | **HIGH** | Gate 3 | **CONFIRMED** | **FIX-2** |
| **R-09a** | Unsupported JSON shapes (`null`, `[]`) crash or silently drop hook registration (`P2, P4`) | `scripts/install-register.mjs:238-273` | **HIGH** | Gate 1 | **CONFIRMED** | **FIX-1** |
| **R-09b** | Invalid GitHub Actions versions (`@v7`) in release package workflow templates (`P2`) | `.github/workflows/` templates | **CRITICAL** | Gate 3 | **CONFIRMED** | **FIX-2** |
| **R-10a** | Suites 6 & 7 mutate host profile and depend on proprietary `Waymark` fixtures (`P2, P4`) | `tests/test-installed-verification.mjs`, `test-lifecycle-rollback.mjs` | **HIGH** | Gate 3 | **CONFIRMED** | **FIX-1 / FIX-2** |
| **R-10b** | Suite 4 E2E brittle branch assertion on `rtk git status` (`P2, P4`) | `tests/test-e2e-probes.mjs:140` | **HIGH** | Gate 3 | **CONFIRMED** | **FIX-2** |
| **R-11** | PowerShell installer hardcodes paths and fails to forward CLI arguments (`P2`) | `install.ps1:17-38` | **MEDIUM** | Gate 1 | **CONFIRMED** | **FIX-1** |
| **R-12** | `--restore-backups` without `uninstall` falls through to install (`P2, P4`) | `scripts/install-register.mjs:650-658` | **MEDIUM** | Gate 1 | **CONFIRMED** | **FIX-1** |
| **R-13** | Release workflow missing npm provenance attestation (`P2, P3`) | Release workflow | **MEDIUM** | Gate 4 | **CONFIRMED** | **FIX-2** |
| **R-08** | Missing community health & security disclosure policies (`P2, P3`) | Root directory | **MEDIUM** | Gate 4 | **CONFIRMED** | **FIX-4** |
| **R-05** | Documentation test suite count synchronization (8 $\to$ 10 once regression suites added) (`P2`) | `README.md`, `docs/publishing.md` | **LOW** | Gate 3 | **PENDING** | **FIX-4** |

---

## 3. Remediation Allocation Strategy

- **FIX-1 (Installer Fail-Safe & Config Preservation)**:
  - Owns: `scripts/install-register.mjs`, `install.ps1`, `templates/tests/test-check-only-readonly.mjs`, `templates/tests/test-malformed-config-preservation.mjs`.
  - Solves: R-01, R-02, R-09a, R-11, R-12.
- **FIX-2 (CI Matrix, Package Verification & Workflow Hardening)**:
  - Owns: `package.json`, `tests/test-e2e-probes.mjs`, `tests/test-installed-verification.mjs`, `tests/test-lifecycle-rollback.mjs`, `.github/workflows/ci-matrix.yml`, `.github/workflows/release-tag.yml`, `scripts/release-preflight.mjs`.
  - Solves: R-04, R-07, R-09b, R-10a, R-10b, R-13.
- **FIX-3 (RTK Supply Chain & Platform Hardening)**:
  - Owns: `scripts/provision-rtk.mjs`, `docs/RTK-SUPPORT-MATRIX.md`, `docs/INSTALLER-HARDENING.md`.
  - Solves: R-03a, R-03b, R-03c.
- **FIX-4 (Community Health & Trust Documentation)**:
  - Owns: `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `README.md`, `docs/publishing.md`.
  - Solves: R-08, R-05.
