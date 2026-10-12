# Publishing & Verification

This guide outlines the quality checks, clean-room verification procedures, and release processes for `Agy-Context-Saver`.

---

## Packaging Whitelist

The published npm package is strictly constrained via the `"files"` whitelist in `package.json`:

```json
"files": [
  "assets",
  "mcp",
  "scripts",
  "rules",
  "skills",
  "hooks.json",
  "plugin.json",
  "mcp_config.json",
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

Before releasing any version or publishing to npm, execute the full 4-stage audit:

### Stage 1: Installation Pre-flight
```bash
node scripts/install-register.mjs --check
```
Ensures plugin links, hook scripts, and tool schemas exist and match versions.

### Stage 2: Automated Test Matrix
```bash
npm test
```
Executes all 11 verification suites:
1. Intelligent hook governance & closed-topology tests (`tests/test-hook.mjs`)
2. MCP server protocol & method tests (`tests/test-mcp.mjs`)
3. Output inspection governance & lifecycle gating tests (`tests/test-output-governance.mjs`)
4. End-to-end edge case & fail-closed probes (`tests/test-e2e-probes.mjs`)
5. Performance, streaming & memory probes (`tests/test-performance-probes.mjs`)
6. Live installed system validation (`tests/test-installed-verification.mjs`)
7. Full lifecycle installation, rollback, and restoration test (`tests/test-lifecycle-rollback.mjs`)
8. Subagent delegation & batching trials (`tests/test-subagent-trials.mjs`)
9. Check-only read-only isolation regression test (`tests/test-check-only-readonly.mjs`)
10. Malformed config preservation fail-closed regression test (`tests/test-malformed-config-preservation.mjs`)
11. Dual-MCP Waymark code intelligence & subagent synergy suite (`tests/test-waymark-synergy.mjs`)

### Stage 3: Tarball Dry-Run Inspection
```bash
npm pack --dry-run
```
Verifies that:
- Total unpacked size is ~170 KB (compressed <50 KB).
- Exactly 17 canonical runtime files are present (including `assets/logo.svg`).
- Zero development/test files leak into distribution.

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
git commit -m "chore(release): prepare v1.6.1"
git tag -a v1.6.1 -m "Release v1.6.1"

# 2. Publish to npm registry
npm publish --access public
```
