---
name: context-governance
description: >-
  Use ONLY when explicitly configuring or troubleshooting Agy-Context-Saver features
  outside rules/AGENTS.md: opt-in stall watchdogs or remote CI timers, RTK pre-gate/config, or agy-context
  setup/status/uninstall. Do NOT load for routine quick builds, tests, file reads,
  or standard file reads already covered by rules/AGENTS.md (load for
  hang-prone/unattended stall watchdogs or remote CI timers).
---

# Context Governance (`Agy-Context-Saver` + `RTK`)

`rules/AGENTS.md` already covers everyday execution, `read_file` bounds, Pure Yield, and native transcript reads. Use this skill for the 3 on-demand workflows below, loading a reference file only when you need full flag matrices or hook internals.

## Quick Reference (On-Demand Workflows)

| Workflow | Command / Rule |
| --- | --- |
| **Opt-in watchdogs & remote CI** | Default local tasks use Pure Yield (no `schedule`). For unattended `/goal` or hang-prone jobs, bind `TimerCondition="<convId>/task-X"` (`45-60s` quick/hang-risk, `120-180s` test suites/builds, `300-600s` E2E/Docker; hard floor `30s -> 75s -> 188s -> 469s -> 600s`). Direct subagents: `TimerCondition="<subagentConvId>"` (`180s -> 450s -> 600s`). Remote CI (`gh pr checks`/`gh run list`): `schedule >= 30s` (no `--watch`). |
| **RTK & config flags** | `AGY_RTK_MODE=pregate\|off` (default `pregate`; explicit `rtk <cmd>` always works; precision tools & `--json`/`--porcelain` pass through). `AGY_DISABLE_BENCHMARK_GUARD=1` opts top-level sessions out of `benchmarks/`/`evaluation/` `force_ask`. |
| **Setup / status / lifecycle** | `agy-context transcript health [--id <u1,u2>] [--parent <id>] [--json]` (read-only session metrics), `agy-context status [--json]`, `agy-context setup [--check] [--allow-degraded]`, `agy-context uninstall [--restore-backups]`, `agy-context restore-backups` (only run `uninstall`/`restore-backups` when explicitly asked) |

## Detailed References (Read Only If Needed)

- **Layer 1–3 Hook Guardrails, Watchdog Backoff, RTK Allowlist & Config Protection:** Read [guardrails.md](references/guardrails.md)
- **Full `agy-context` CLI Flag Reference:** Read [cli.md](references/cli.md)
