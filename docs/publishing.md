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
`scripts/release-preflight.mjs` checks `package.json` metadata, `hooks.json` matcher coverage (`read_file`, `edit_file`, `write_file`, `run_command`), `lib/transcript-core.mjs` and `bin/agy-context.mjs` entrypoints, absence of legacy root `mcp/` or `mcp_config.json`, `README.md` test suite count parity (12 suites), `SECURITY.md`/`CONTRIBUTING.md`/`CODE_OF_CONDUCT.md` presence, `MIN_RTK_VERSION >= 1.1.0`, and zero runtime npm dependencies. `node scripts/install-register.mjs --check` validates RTK `>= 1.1.0` and user config syntax without writing to disk.

### Stage 2: Automated test matrix
```bash
npm test
```
Runs all 12 test suites in isolated temporary profiles:
1. Hook governance, RTK `>= 1.1.0` delegation, `agy-context transcript` pass-through, `self-only` `--id <convId>` injection, and transcript access hardening (`tests/test-hook.mjs`)
2. Streaming transcript core, CLI aliases, step range slicing, and single-use capability grants (`tests/test-transcript.mjs`)
3. Live host RTK `>= 1.1.0` integration contract and `agy-context transcript` pass-through (`tests/test-rtk-integration.mjs`)
4. Output spillover and completed task log lifecycle gating (`tests/test-output-governance.mjs`)
5. End-to-end edge cases and fail-closed probes (`tests/test-e2e-probes.mjs`)
6. Performance, streaming, and file-descriptor cleanup probes (`tests/test-performance-probes.mjs`)
7. Installed system verification (`tests/test-installed-verification.mjs`)
8. Lifecycle installation, stale MCP cleanup, and backup rollback (`tests/test-lifecycle-rollback.mjs`)
9. Check-only read-only isolation regression check (`tests/test-check-only-readonly.mjs`)
10. Malformed config preservation fail-closed check (`tests/test-malformed-config-preservation.mjs`)
11. RTK ledger fresh-install verification (`tests/test-rtk-ledger-fresh-install.mjs`)
12. Package whitelist and tarball verification self-test (`tests/verify-package.mjs`)

### Stage 3: Tarball & package manifest verification
```bash
npm run verify:package
```
Runs `node tests/verify-package.mjs --self-test` and validates `npm pack --dry-run --json` against the whitelisted files in `package.json` (`33` files).

### Stage 4: Documentation build
```bash
zensical build
```
Validates Markdown links, navigation entries, and SVG assets.

---

## Tagging & Publishing (`release-tag.yml`)

Pushing a `v*` tag triggers `.github/workflows/release-tag.yml`, which runs the verification matrix across Linux, macOS, and Windows (Node 22 and 24), creates the GitHub Release, and publishes to npm via OIDC Trusted Publishing (`npm publish --access public --provenance`):

```bash
git commit -m "chore(release): v2.0.1"
git tag -a v2.0.1 -m "Release v2.0.1"
git push origin main --follow-tags
```
