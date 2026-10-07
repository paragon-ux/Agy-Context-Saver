# Publishing & Verification

This guide outlines the quality checks, clean-room verification procedures, and release processes for `Agy-Context-Saver`.

---

## Packaging Whitelist

The published npm package is strictly constrained via the `"files"` whitelist in `package.json`:

```json
"files": [
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
Executes all 5 verification suites:
1. Intelligent hook decision tests (18 assertions)
2. MCP server protocol tests (12 assertions)
3. End-to-end fail-open probes (6 assertions)
4. Live installed system validation
5. Full lifecycle installation, rollback, and restoration test

### Stage 3: Tarball Dry-Run Inspection
```bash
npm pack --dry-run
```
Verifies that:
- Total unpacked size is <120 KB.
- Exactly 13 runtime files are present.
- Zero development/test files leak into distribution.

### Stage 4: Documentation Build
```bash
py -3.11 -m zensical build
```
Validates Markdown syntax, navigation structure, and asset paths with zero build warnings.

---

## Release & Publication

Once all 4 verification stages pass:

```bash
# 1. Commit and tag release
git commit -m "chore(release): prepare v1.0.0"
git tag -a v1.0.0 -m "Release v1.0.0"

# 2. Publish to npm registry
npm publish --access public
```
