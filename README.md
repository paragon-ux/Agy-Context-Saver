# Agy-Context-Saver 🛡️

**Model Context Protocol (MCP) Server & Lifecycle Governor for Google Antigravity**

[![npm version](https://img.shields.io/npm/v/agy-context-saver.svg)](https://www.npmjs.com/package/agy-context-saver)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/agy-context-saver/)
[![Tests](https://img.shields.io/badge/tests-100%25%20passing-brightgreen.svg)](https://github.com/paragon-ux/agy-context-saver/actions)

`Agy-Context-Saver` is a lightweight, zero-dependency MCP server and lifecycle governor purpose-built for **Google Antigravity** (`agy`). It permanently eliminates session degradation, memory bloat, and context window exhaustion caused by **background task busy-wait polling** and **raw JSON transcript reading**.

---

## The Core Problems Solved

1. **The Polling Trap**: When shell tasks detach to background jobs (`task-XYZ`), models waste tokens by repeatedly calling `manage_task(Action='status')` or short timers. This pollutes transcripts with hundreds of raw ASCII progress dots and ANSI escape sequences.
2. **The Raw Transcript Trap**: Naive `view_file` reads on multi-megabyte `transcript.jsonl` files flood the working memory with raw JSON syntax, bracket overhead, and truncated line references, triggering rapid context compaction amnesia.

---

## 3-Layer Defense Overview

```mermaid
graph TD
    A["Agent calls<br/>manage_task(status)"] -->|PreToolUse Hook| B["DENIED<br/>Yield turn to Reactive Wakeup"]
    C["Agent calls<br/>view_file(transcript)"] -->|PreToolUse Hook| D["DENIED<br/>Redirect to read_transcript"]
    E["Agent calls<br/>safe_command"] -->|MCP Tool| F["Execute with<br/>Output Compression + 24KB Cap"]
    G["Agent audits<br/>history"] -->|MCP Tool| H["read_transcript /<br/>query_transcript (Zero JSON)"]
    I["Agent needs<br/>exploration"] -->|MCP Tool| J["subagent_brief<br/>offload to sub-transcript"]
```

---

## Quickstart (Instant Install)

Install and activate the governor across your Antigravity environment in milliseconds:

```bash
# Fastest: one-line registration via npx
npx agy-context-saver install

# Or locally from this repository
npm run setup

# Audit health at any time
npm run status
```

---

## Key Features

- **Intelligent Output Compression**: Collapses massive compiler loops and test dot streams to concise summaries.
- **Hard 24 KB Ceiling & Line Clamping**: Strictly prevents the Antigravity host process from spilling tool returns onto disk as `.system_generated/steps/...` files.
- **Dynamic Workspace Cwd Detection**: Resolves active project directories automatically from Antigravity's local SQLite database.
- **Compact UI Mode (`terse: true`)**: Clean passes (exit code 0) return a 1-line confirmation card, eliminating UI clutter.
- **Clean Markdown Transcripts**: Stream conversation turns without raw JSON syntax using `read_transcript` and `query_transcript`.
- **Zero External Dependencies**: 100% native Node.js standard library. Zero npm supply-chain risk.

---

## Comprehensive Documentation

For complete technical specifications, architectural diagrams, parameter references, and lifecycle hook internals, visit our **[Zensical Documentation Site](https://paragon-ux.github.io/agy-context-saver/)**:

- 📖 **[Installation & Setup](docs/installation.md)**: NPX, native plugin symlinking, manual configuration, and clean uninstallation.
- 🛠️ **[MCP Tool Reference](docs/tools.md)**: Full parameter tables, return contracts, and examples for all 7 tools.
- 🛡️ **[Lifecycle Governance](docs/governance.md)**: `PreToolUse` hook mechanics, 3-tier circuit breaker, and fail-open guarantees.
- 🏗️ **[Architecture & Internals](docs/architecture.md)**: 3-layer defense model, buffer aggregation, and SQLite workspace resolution.
- 📦 **[Publishing & Verification](docs/publishing.md)**: Packaging whitelist, pre-flight audits, and release instructions.

---

## Local Documentation Server

Build or serve the documentation locally using **Zensical**:

```bash
# Build static site
py -3.11 -m zensical build

# Serve live preview
py -3.11 -m zensical serve
```

---

## License

MIT License. Copyright (c) 2026 paragon-ux.
