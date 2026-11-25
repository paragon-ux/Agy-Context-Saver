# Publishing & Verification

This guide covers the preflight checks, test suite matrix, and release workflow for `Agy-Context-Saver`.

---

## Packaging Whitelist

The `"files"` list in `package.json` defines the published npm package contents:

```json
"files": [
  "assets",
  "bin/agy-context.mjs",
  "docs",
  "!docs/plans/**",
  "!docs/plans",
  "!docs/reviews/**",
  "!docs/reviews",
  "lib",
  "scripts",
  "rules",
  "skills",
  "hooks.json",
  "plugin.json",
  "install.ps1",
  "install.sh",
  "README.md",
  "CHANGELOG.md",
  "LICENSE"
]
```

Excluded from the npm tarball:
- `docs/plans/` and `docs/reviews/` (internal maintainer architecture ledgers and review records)
- `tests/` (unit, integration, and lifecycle test suites)
- `zensical.toml` (docs site generator configuration)
- Local `.gitignore`d binaries (such as `bin/rtk`), temporary files, and scratch directories

---

## Verification Pipeline

Run all four stages before tagging a release:

### Stage 1: Release preflight and read-only check
```bash
node scripts/release-preflight.mjs
node scripts/install-register.mjs --check
```
`scripts/release-preflight.mjs` checks `package.json` metadata, `plugin.json` and `hooks.json` validity, `bin/agy-context.mjs`, and modular `lib/` + `scripts/hook/` runtime entrypoints, absence of legacy root `mcp/` or `mcp_config.json`, `docs/publishing.md` test suite count parity (12 suites), `SECURITY.md`/`CONTRIBUTING.md`/`CODE_OF_CONDUCT.md` presence, `MIN_RTK_VERSION >= 1.1.0`, and zero runtime npm dependencies. `node scripts/install-register.mjs --check` validates RTK `>= 1.1.0` and user config syntax without writing to disk.

### Stage 2: Automated test matrix
```bash
npm test
```
Runs all 11 test suites in isolated temporary profiles:
1. Hook governance, RTK `>= 1.1.0` delegation, and native read and write guards (`tests/test-hook.mjs`)
2. Live host RTK `>= 1.1.0` integration contract (`tests/test-rtk-integration.mjs`)
3. Output spillover and completed task log lifecycle gating (`tests/test-output-governance.mjs`)
4. End-to-end edge cases and fail-closed probes (`tests/test-e2e-probes.mjs`)
5. Performance, streaming, and file-descriptor cleanup probes (`tests/test-performance-probes.mjs`)
6. Installed system verification (`tests/test-installed-verification.mjs`)
7. Lifecycle installation, stale MCP cleanup, and backup rollback (`tests/test-lifecycle-rollback.mjs`)
8. Check-only read-only isolation regression check (`tests/test-check-only-readonly.mjs`)
9. Malformed config preservation fail-closed check (`tests/test-malformed-config-preservation.mjs`)
10. RTK ledger fresh-install verification (`tests/test-rtk-ledger-fresh-install.mjs`)
11. Package whitelist and tarball verification self-test (`tests/verify-package.mjs`)

### Stage 3: Tarball & package manifest verification
```bash
npm run verify:package
```
Runs `node tests/verify-package.mjs --self-test` and validates `npm pack --dry-run --json` against the whitelisted files in `package.json` (covering the modular `lib/` and `scripts/hook/` runtime layout while excluding internal `docs/plans/`, `docs/reviews/`, and `tests/`).

### Stage 4: Documentation build
```bash
zensical build
```
Validates Markdown links, navigation entries, and SVG assets.

---

## Tagging & Publishing (`release-tag.yml`)

Pushing a `v*` tag triggers `.github/workflows/release-tag.yml`, which runs the verification matrix across Linux, macOS, and Windows (Node 22 and 24), creates the GitHub Release, and publishes to npm via OIDC Trusted Publishing (`npm publish --access public --provenance`):

```bash
git commit -m "chore(release): v2.3.0"
git tag -a v2.3.0 -m "Release v2.3.0"
git push origin main --follow-tags
```
