# Agy-Context-Saver

[![npm version](https://img.shields.io/npm/v/agy-context-saver.svg)](https://www.npmjs.com/package/agy-context-saver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/Agy-Context-Saver/)
[![CI](https://github.com/paragon-ux/Agy-Context-Saver/actions/workflows/ci-matrix.yml/badge.svg)](https://github.com/paragon-ux/Agy-Context-Saver/actions/workflows/ci-matrix.yml)
[![CodeQL](https://github.com/paragon-ux/Agy-Context-Saver/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/paragon-ux/Agy-Context-Saver/actions/workflows/github-code-scanning/codeql)

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

Agy-Context-Saver is a PreToolUse execution hook and transcript CLI for Google Antigravity on Linux, macOS, and Windows (Node.js 22 or newer, zero external npm dependencies). Paired with RTK (1.1.0 or newer), a CLI proxy that compresses noisy shell and test output, it shrinks command logs, keeps workspace file reads bounded, stops background-task polling loops, and lets parent sessions govern child subagent and swarm transcript access.

## Quickstart

Requires Node.js 22 or newer and Google Antigravity 2.0+. Setup uses an existing RTK 1.1.0+ installation or downloads a SHA-256-verified binary automatically.

```bash
# Install the plugin, PreToolUse hook, and agy-context CLI
npx --package=agy-context-saver agy-context setup

# Verify installation and active policy status
npx --package=agy-context-saver agy-context status
```

Reload Antigravity Desktop IDE or start a new session after setup or uninstall finishes so hook registrations activate or clear from memory cleanly. For shell PATH configuration, local checkout setup, v1.x upgrades, and clean uninstallation, see the [Installation and setup guide](https://paragon-ux.github.io/Agy-Context-Saver/installation/).

## How Agy-Context-Saver guards a default session

Agy-Context-Saver layers a lightweight pre-tool hook on top of Google Antigravity's native shell, file, and background-task tools rather than replacing them. It compresses noisy terminal output through RTK, keeps workspace file reads focused, blocks shell and file mutations targeting protected hook and configuration paths, prevents background polling loops, and lets parent sessions control child transcript access:

![Default Antigravity session vs. Antigravity with Agy-Context-Saver](docs/assets/default-vs-context-saver.svg)

## Transcript CLI vs. native Antigravity

Google Antigravity stores conversation history as raw log files on disk without a dedicated transcript tool. Rather than looking up session IDs, opening multi-megabyte logs directly, or matching cut-off outputs across a second file by hand, the agy-context transcript CLI finds recent sessions and child worker teams automatically, keeps inline summaries under 9.2 KB, pulls full step details on demand, checks session and team health, and lets parent sessions control child access or export redacted summaries:

![Native Antigravity logs vs. agy-context Transcript CLI](docs/assets/transcript-cli-vs-native.svg)

For subcommand workflows, output budgets, and operational notes, see the [Transcript CLI vs. native Antigravity guide](https://paragon-ux.github.io/Agy-Context-Saver/transcript-cli/).

## Documentation

Read the full documentation at [paragon-ux.github.io/Agy-Context-Saver](https://paragon-ux.github.io/Agy-Context-Saver/):

- [Overview](https://paragon-ux.github.io/Agy-Context-Saver/)
- [Installation and setup](https://paragon-ux.github.io/Agy-Context-Saver/installation/)
- [CLI and hook reference](https://paragon-ux.github.io/Agy-Context-Saver/tools/)
- [Transcript CLI vs. native Antigravity](https://paragon-ux.github.io/Agy-Context-Saver/transcript-cli/)
- [Lifecycle governance and transcript access control](https://paragon-ux.github.io/Agy-Context-Saver/governance/)
- [Architecture and internals](https://paragon-ux.github.io/Agy-Context-Saver/architecture/)
- [Installer hardening policy](https://paragon-ux.github.io/Agy-Context-Saver/INSTALLER-HARDENING/)
- [RTK support matrix](https://paragon-ux.github.io/Agy-Context-Saver/RTK-SUPPORT-MATRIX/)
- [Publishing and verification](https://paragon-ux.github.io/Agy-Context-Saver/publishing/)
- [Product roadmap](https://paragon-ux.github.io/Agy-Context-Saver/roadmap/)

For multi-agent cohort planning and SHA-256 proof bundling, see the companion [Agy-Squad](https://paragon-ux.github.io/Agy-Squad/) plugin.

## License

MIT License. Copyright (c) 2026 paragon-ux.
