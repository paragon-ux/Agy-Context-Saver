# Agy-Context-Saver

[![npm version](https://img.shields.io/npm/v/agy-context-saver.svg)](https://www.npmjs.com/package/agy-context-saver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/Agy-Context-Saver/)
[![Tests](https://img.shields.io/badge/tests-100%25%20passing-brightgreen.svg)](https://github.com/paragon-ux/Agy-Context-Saver/actions)

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

Agy-Context-Saver is a PreToolUse execution hook and transcript CLI for Google Antigravity on Linux, macOS, and Windows (Node.js 22 or newer, zero external npm dependencies). Paired with RTK 1.1.0 or newer, it compresses shell output, keeps workspace file reads bounded, stops background-task polling loops, and lets parent sessions govern child subagent and swarm transcript access.

## Quickstart

Requires Node.js 22 or newer and Google Antigravity 2.0+. Setup uses an existing RTK 1.1.0+ installation or downloads a SHA-256-verified binary automatically.

```bash
# Install the plugin, PreToolUse hook, and agy-context CLI
npx --package=agy-context-saver agy-context setup

# Verify installation and active policy status
npx --package=agy-context-saver agy-context status
```

Reload Antigravity Desktop IDE or start a new session after setup finishes so the hook, rules, and skill activate. For shell PATH configuration, local checkout setup, v1.x upgrades, and clean uninstallation, see the [Installation and setup guide](https://paragon-ux.github.io/Agy-Context-Saver/installation/).

## Documentation

Read the full documentation at [paragon-ux.github.io/Agy-Context-Saver](https://paragon-ux.github.io/Agy-Context-Saver/):

- [Overview](https://paragon-ux.github.io/Agy-Context-Saver/)
- [Installation and setup](https://paragon-ux.github.io/Agy-Context-Saver/installation/)
- [CLI and hook reference](https://paragon-ux.github.io/Agy-Context-Saver/tools/)
- [Lifecycle governance and transcript access control](https://paragon-ux.github.io/Agy-Context-Saver/governance/)
- [Architecture and internals](https://paragon-ux.github.io/Agy-Context-Saver/architecture/)
- [Installer hardening policy](https://paragon-ux.github.io/Agy-Context-Saver/INSTALLER-HARDENING/)
- [RTK support matrix](https://paragon-ux.github.io/Agy-Context-Saver/RTK-SUPPORT-MATRIX/)
- [Publishing and verification](https://paragon-ux.github.io/Agy-Context-Saver/publishing/)
- [Product roadmap](https://paragon-ux.github.io/Agy-Context-Saver/roadmap/)

For multi-agent cohort planning and SHA-256 proof bundling, see the companion [Agy-Squad](https://paragon-ux.github.io/Agy-Squad/) plugin.

## License

MIT License. Copyright (c) 2026 paragon-ux.
