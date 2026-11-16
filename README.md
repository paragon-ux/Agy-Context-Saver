# Agy-Context-Saver

[![npm version](https://img.shields.io/npm/v/agy-context-saver.svg)](https://www.npmjs.com/package/agy-context-saver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/Agy-Context-Saver/)
[![Tests](https://img.shields.io/badge/tests-100%25%20passing-brightgreen.svg)](https://github.com/paragon-ux/Agy-Context-Saver/actions)

`Agy-Context-Saver` is a `PreToolUse` execution hook and transcript CLI (`agy-context`) for **Google Antigravity** (`agy`) on Linux, macOS, and Windows (`Node.js >= 22`, zero external npm dependencies). It pairs with **RTK (`>= 1.1.0`)** to compress shell output, bound workspace file reads, stop background-task busy-polling, and govern transcript inspection across parent sessions, subagents, and `/swarm` workers.

![Agy-Context-Saver and RTK execution topology](assets/architecture-overview.svg)

The repository ships four components:

- **`PreToolUse` execution hook ([`hooks.json`](hooks.json), [`scripts/execution-guard-hook.mjs`](scripts/execution-guard-hook.mjs)):** Delegates `run_command` rewriting to `rtk hook antigravity`, requires bounded `read_file` line slices (`<= 150` lines, or explicit `1..TotalLines` reads on files `<= 800` lines and `<= 45 KiB`), upgrades unset `WaitMsBeforeAsync` to `10s`, enforces exponential backoff on `manage_task` and `schedule` with a 5-strike `force_ask` circuit breaker, and blocks direct file or shell access to `.system_generated/` and the state directory.
- **Transcript forensics CLI ([`bin/agy-context.mjs`](bin/agy-context.mjs), [`lib/transcript-core.mjs`](lib/transcript-core.mjs)):** Streams conversation turns in Markdown, searches compact and full logs by regex or role, extracts single steps or step ranges with `--head`/`--tail` slicing, lists parent/child lineage, exports sanitized transcripts, and audits session turn budgets (`read`, `query`, `step`, `health`, `list`, `export`, `access`).
- **Parent transcript access control (`agy-context transcript access`):** Lets parent sessions restrict or scope child subagent and `/swarm` worker transcript access on demand (`open`, `allowlist`, `self-only`, `deny`) via CLI flags (`--off`, `--self-only`, `--allow @audit-squad*`) or first-line launch directives (`[agy-transcript-access: deny|self-only|allow]`), backed by 10-second single-use capability grants.
- **Agent rules and skill ([`rules/AGENTS.md`](rules/AGENTS.md), [`skills/context-governance/SKILL.md`](skills/context-governance/SKILL.md)):** Installed into `~/.gemini/config/plugins/agy-context-saver` so Antigravity sessions inherit the inspection and Reactive Wakeup rules automatically. Multi-agent cohort planning and SHA-256 evidence bundling live in the companion [Agy-Squad](https://github.com/paragon-ux/Agy-Squad) repository.

## Quickstart

### Prerequisites

- **Node.js:** `>= 22.0.0`
- **Google Antigravity:** Antigravity 2.0+ (Desktop IDE or `agy` CLI)
- **RTK:** `>= 1.1.0` (`brew install rtk`, `cargo install --locked rtk`, or downloaded automatically into `bin/` during `agy-context setup` with pinned SHA-256 verification)

### Install and verify

```bash
# Install via npx
npx --package=agy-context-saver agy-context setup

# Or from a local checkout
npm run setup

# Check installation and active policy status
agy-context status
```

> **Upgrading from v1.x:** Running `agy-context setup` automatically removes legacy `mcp_config.json` entries, sweeps stale `~/.gemini/antigravity/mcp/agy-context-saver*` schema caches, and replaces the retired v1.x MCP server with the on-demand `agy-context` CLI and updated `PreToolUse` hook.

To remove the plugin link, hook entries, and CLI shims:

```bash
agy-context uninstall
# Or restore pre-install .bak configuration files:
agy-context uninstall --restore-backups
```

## CLI and hook summary

| Surface | Purpose | Common usage |
| :--- | :--- | :--- |
| `agy-context transcript health` (`stats`, `info`) | Check turn counts, transcript byte size, RTK status, and polling events | `agy-context transcript health [<id>] [--json]` |
| `agy-context transcript read` | Read recent turns in Markdown (`--outline` delegates to `query` summary) | `agy-context transcript read [<id>] --last-turns 3` |
| `agy-context transcript query` (`grep`, `search`, `find`, `tools`, `outline`, `summary`) | Search compact and truncated full steps by regex, role, tool call arguments, or print a 1-line-per-step outline | `agy-context transcript grep "<pattern>" [<id>] --summary` / `agy-context transcript outline [<id>]` |
| `agy-context transcript step` | Extract untruncated fields for a step, comma list, or range (`N..M`) | `agy-context transcript step 10..15 [<id>] --field content --tail 40` |
| `agy-context transcript list` (`ls`) | List recent conversation transcripts in the Antigravity brain directory (supports `--parent` and `--lineage`) | `agy-context transcript ls --parent <uuid> --lineage --limit 5` |
| `agy-context transcript export` (`dump`) | Export an L6-safe `--sanitized` transcript summary index to stdout or `--out` (`--sanitized` required) | `agy-context transcript export [<id>] --sanitized --out scratch/export.md` |
| `agy-context transcript access` (`policy`) | View or update child subagent and `/swarm` worker transcript access | `agy-context transcript access --status` / `--off` / `--self-only` / `--allow @audit-squad*` / `--on` |
| `agy-context status` / `setup` / `uninstall` | Audit, synchronize, or remove plugin link, hook, CLI shims, and RTK config | `agy-context status` / `agy-context setup --check` |

## Documentation

Full documentation is hosted at [paragon-ux.github.io/Agy-Context-Saver](https://paragon-ux.github.io/Agy-Context-Saver/) and in [`docs/`](docs/):

- [Overview](docs/index.md)
- [Installation and setup](docs/installation.md)
- [CLI and hook reference](docs/tools.md)
- [Lifecycle governance and transcript access control](docs/governance.md)
- [Architecture and internals](docs/architecture.md)
- [Installer hardening policy](docs/INSTALLER-HARDENING.md)
- [RTK support matrix](docs/RTK-SUPPORT-MATRIX.md)
- [Publishing and verification](docs/publishing.md)
- [Product roadmap](docs/roadmap.md)

## Development

Run `node scripts/release-preflight.mjs` and `npm test` with Node.js `>= 22`. Runs all 12 test suites (`tests/test-hook.mjs`, `tests/test-transcript.mjs`, `tests/test-rtk-integration.mjs`, `tests/test-output-governance.mjs`, `tests/test-e2e-probes.mjs`, `tests/test-performance-probes.mjs`, `tests/test-installed-verification.mjs`, `tests/test-lifecycle-rollback.mjs`, `tests/test-check-only-readonly.mjs`, `tests/test-malformed-config-preservation.mjs`, `tests/test-rtk-ledger-fresh-install.mjs`, and `tests/verify-package.mjs`) in isolated temporary profiles without mutating your live `~/.gemini` directory.

## License

MIT License. Copyright (c) 2026 paragon-ux.
