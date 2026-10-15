# Decision and work ledger (canonical)

This file is the **single source of truth** for Agy-Context-Saver's cross-cutting decisions and open items.

**When to read it:** every session reads it first, and again after any context compaction.

**Where the detail lives:** the plans hold the reasoning. This file holds the status, and points to them.

**Updating it:**
- **One row per decision.** Keep each row to one or two sentences; the reasoning goes in a plan, linked from the row.
- Every commit or PR that settles or changes an item updates its row in the same commit.
- **Mark items `done` as they land, with the commit that completed them.**
- A decision made in a side chat is not settled until it has a row here with its source.
- **Conflicts** between two recorded decisions:
  - a **minor** one: the newer decision wins; record it and note the conflict in the row;
  - a **major** one: mark it `conflict` and ask the user.
- Rows proposed by an agent stay `open` until the user confirms them.
- **Row IDs are shared with [Agy-Squad's ledger](https://github.com/paragon-ux/agy-squad/blob/main/docs/plans/LEDGER.md) and never reused.** A row keeps its ID when it moves between the two, which is why each ledger has gaps.

**Status values:**
- `open`: not decided, or proposed and not yet confirmed by the user;
- `decided`: decided, not yet built (or built but not yet committed, as the row says);
- `in PR n`: being built in that PR;
- `done`: completed and committed (the row cites the commit);
- `conflict`: two recorded decisions disagree, and only the user settles it.

**Sources:**
- `user`: the user's own words;
- `main`: the main working chat;
- `side`: the user's side chat, pasted into main.

## Where the item registries live

| IDs | Registry |
|---|---|
| L1–L12, L16–L24, L28–L31; P0–P5, V1–V8 (subagents and the Docker sandbox) | Agy-Squad: `docs/plans/LEDGER.md` and `docs/plans/docker-sandbox-plan.md` |

## Ledger

### Invariants

| ID | Item | Source | Status | Decision | Link |
|---|---|---|---|---|---|
| L32 | The user's zero-trust invariants bind this repo too | user, 2026-10-14 | decided | Agy-Squad's L1 (zero trust), L2 (no regex security perimeter), L4 (no shared state in `os.tmpdir()`) and L7 (tests never start real agents) apply to Agy-Context-Saver's hook and tests. | Agy-Squad ledger |
| L33 | The hook's governance state lived in `os.tmpdir()` | main, 2026-10-15; user accepted 2026-10-15, on condition that uninstall removes every leftover | decided | Built for 1.8.0, not yet committed. The polling ledger and RTK rewrite cache now live in `%LOCALAPPDATA%\agy-context-saver\` (`$XDG_STATE_HOME/agy-context-saver` on POSIX). Install removes the legacy temp-folder files; uninstall removes the state folder and the legacy files. `test-lifecycle-rollback` checks both. | `scripts/state-dir.mjs` |

### Breach cleanup (2026-10-14)

| ID | Item | Source | Status | Decision | Link |
|---|---|---|---|---|---|
| L13 | Root cause | main, 2026-10-15 | decided | `tests/test-mcp.mjs` ran `dispatch_squad` with `mode: "direct"`, which spawned 14 live host agents through the private language-server RPC. | — |
| L14 | Remove direct mode | user, 2026-10-15 | decided | Built, not yet committed. `mcp/direct-rpc.mjs`, the direct test block and the `BypassSandbox` hook overwrite are gone from `main`. They survive only on the local branch `wip/subagent-squad` (never pushed) and were not carried into Agy-Squad. | Agy-Squad plan P0 |
| L15 | Remove every subagent tool and script | user, 2026-10-15 | decided | Built, not yet committed. `subagent_brief`, its schema, the subagent tests and the subagent guidance are gone. The installer retires `subagent_brief.json` and `dispatch_squad.json` from existing installs. Kept: the anti-orphan exit handlers and the `isEntryPoint` guard. (This replaces two earlier versions of the row: keep everything, then keep the simple brief. The user's words win.) | Agy-Squad plan P0 |

### Repository and docs

| ID | Item | Source | Status | Decision | Link |
|---|---|---|---|---|---|
| L25 | Plans live in `docs/plans/` | user, 2026-10-15 | decided | Docs stay a Zensical site, as in waymark-engine and PDLt; plans and this ledger sit under `docs/plans/`, outside the nav. | `zensical.toml` |
| L26 | Subagent orchestration and the sandbox live in a separate repository | user, 2026-10-15 | decided | Agy-Context-Saver already fulfills its purpose without subagents, so keep what works separate from what's under construction. Each repo ships as its own installable package, like waymark-engine. | Agy-Squad |
| L27 | Name and location of the new repository | user, 2026-10-15 | decided | `Frameworks/Agy-Squad`. | Agy-Squad |
| L34 | Version for the release without `subagent_brief` | user, 2026-10-15 | decided | 1.8.0, a minor bump: the release adds no features. | `CHANGELOG.md` |
