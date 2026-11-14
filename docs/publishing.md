# Publishing & Verification

This guide outlines the quality checks, clean-room verification procedures, and release processes for `Agy-Context-Saver`.

---

## Packaging Whitelist

The published npm package is strictly constrained via the `"files"` whitelist in `package.json`:

```json
"files": [
  "assets",
  "bin",
  "lib",
  "mcp",
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

### Excluded Development Artifacts
- `tests/` (unit, integration, and lifecycle test suites)
- `docs/` and `zensical.toml` (hosted on GitHub Pages)
- Temporary databases, scratch scripts, and logs

---

## Clean-Room Verification Procedure

Before releasing any version or publishing to npm, execute the full release pipeline:

### Stage 1: Release Preflight & Installation Check
```bash
npm run preflight
node scripts/install-register.mjs --check
```
Verifies package metadata, plugin `hooks.json` schema integrity, `lib/transcript-core.mjs` / `bin/agy-context.mjs`, RTK `>= 1.1.0` requirement, and clean-profile non-mutation.

### Stage 2: Automated Test Matrix
```bash
npm test
```
Executes all 11 verification suites:
1. Hook governance & RTK `>= 1.1.0` delegation tests (`tests/test-hook.mjs`)
2. Streaming transcript core, CLI & deprecated MCP wrapper tests (`tests/test-transcript.mjs`)
3. Live host RTK `>= 1.1.0` integration contract tests (`tests/test-rtk-integration.mjs`)
4. Output inspection governance & lifecycle gating tests (`tests/test-output-governance.mjs`)
5. End-to-end edge case & fail-closed probes (`tests/test-e2e-probes.mjs`)
6. Performance, streaming & memory probes (`tests/test-performance-probes.mjs`)
7. Live installed system validation (`tests/test-installed-verification.mjs`)
8. Full lifecycle installation, `ACS-HOOK-11` sweep & rollback tests (`tests/test-lifecycle-rollback.mjs`)
9. Check-only read-only isolation regression test (`tests/test-check-only-readonly.mjs`)
10. Malformed config preservation fail-closed regression test (`tests/test-malformed-config-preservation.mjs`)
11. RTK ledger fresh-install quirks (`tests/test-rtk-ledger-fresh-install.mjs`)

### Stage 3: Tarball Dry-Run Inspection
```bash
npm pack --dry-run
```
Verifies clean packaging of `bin/`, `lib/`, `scripts/`, `rules/`, `skills/`, and zero development/test file leaks into distribution.

### Stage 4: Documentation Build
```bash
zensical build
```
Validates Markdown syntax, navigation structure, and asset paths with zero build warnings.

---

## Release & Publication

Once all 4 verification stages pass:

```bash
# 1. Commit and tag release
git commit -m "chore(release): prepare v2.0.0"
git tag -a v2.0.0 -m "Release v2.0.0"

# 2. Publish to npm registry
npm publish --access public
```
