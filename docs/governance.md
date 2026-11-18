# Lifecycle Governance & Hooks

The `PreToolUse` hook (`agy-context-saver`, implemented in `scripts/execution-guard-hook.mjs`) evaluates tool calls before Antigravity executes shell commands, file reads/writes, or background task checks.

![PreToolUse hook interception flow](assets/hook-interception-flow.svg)

---

## 3-Layer Governance Rules

### Layer 1: Reactive Lifecycle & Polling Backoff

#### 1. Exponential Backoff on Task Status Checks
Instead of polling `manage_task(Action='status')` in loops, agents yield their turn and wait for **Reactive Wakeup** (`<SYSTEM_MESSAGE>`). Diagnostic status checks follow an exponential cooldown curve:

$$\text{requiredBackoffSeconds} = \min\left(600, \text{round}\left(30 \times 2.5^{\max(0, \text{pollCount} - 1)}\right)\right)$$

| Check # | Required Cooldown | Purpose | Action if Premature |
| :---: | :---: | :--- | :--- |
| **Check 1** | **0s (immediate)** | Initial check upon launch | **Allowed** (`pollCount = 1`) |
| **Check 2** | **30s** | Check for fast tasks | **Denied** with remaining cooldown |
| **Check 3** | **75s** | Standard build progress | **Denied** with remaining cooldown |
| **Check 4** | **188s** | Test suite check | **Denied** with remaining cooldown |
| **Check 5** | **469s** | Long build or hung process | **Denied** with remaining cooldown |
| **Check 6+** | **600s** | Prolonged process | **Denied**; trips `force_ask` circuit breaker |

- **Immediate operations:** `manage_task(Action='kill')` and `manage_task(Action='send_input')` are always allowed immediately (`0s` cooldown, zero penalties).
- **Blocking CI watch loops denied:** `gh pr checks --watch` / `-w` and `gh run watch` inside `run_command` are denied because CI runner queues can hang indefinitely; run one-shot snapshots (`gh pr checks`, `gh run list`) paired with exponential backoff instead.
- **Watchdog timers:** Any `schedule` task watchdog timer must set `DurationSeconds >= Math.max(30, requiredBackoffSeconds)` and pair with a Pre-Yield Status Card. One-shot `schedule` timers polling a `/swarm` or subagent are denied (`swarm_wait` sleeps at zero token cost).
- **5-strike circuit breaker:** At 5 cumulative denials across polling, internal state, or transcript access checks, the hook returns `force_ask` to pause execution and prompt the user.
- **Task log lifecycle gating:**
  - *While running:* reading `tasks/<taskId>.log` via file tools or shell commands is denied under the backoff curve.
  - *When completed:* reading `tasks/<taskId>.log` is allowed via a single unchained `rtk read tasks/<taskId>.log` call.

---

### Layer 2: Shell Rewriting, File Slices & Transcript Governance

1. **Shell command rewriting:** `run_command` calls (`git`, `pytest`, `cargo`, `npm`, etc.) are rewritten via `rtk hook antigravity` (`rtk git`, `rtk pytest`).
2. **Workspace file slices:** Unbounded `read_file` calls on workspace files are redirected to `rtk grep`, `rtk find`, and `rtk ls` paired with bounded `read_file(StartLine, EndLine <= 150)` slices. Full-file reads (`StartLine: 1, EndLine: <TotalLines>`) are allowed when the file on disk is `<= 800` lines and `<= 45 KiB`. Antigravity special files (`SKILL.md`, `AGENTS.md`, brain artifacts, `swarm_view/` narrator state, `.gemini/config/`) pass Safe Harbor without slice bounds.
3. **Step output spillovers:** `.system_generated/steps/<step>/output.txt` files are readable via bounded `read_file(StartLine, EndLine <= 150)` or a single unchained `rtk read <path>` command.
4. **Transcript and state protection:** Direct file or shell access to `.system_generated/logs/transcript*` and `getStateDir()` (`~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows) is blocked. Authorized sessions inspect transcripts via unchained `agy-context transcript` commands.

---

### Layer 3: Synchronous Execution & Benchmark Integrity

1. **10s synchronous window:** On non-daemon `run_command` calls where `WaitMsBeforeAsync` is omitted, the hook sets `WaitMsBeforeAsync` to `10,000ms` while preserving explicit caller timeouts.
2. **Benchmark file protection:** Edits or writes targeting benchmark definitions, evaluation templates, or scoring files require `force_ask` user confirmation.

---

## Parent Transcript Access Control

In multi-agent runs (`define_subagent`, `invoke_subagent`, `/swarm`, and Agy-Squad), a parent coordinator can isolate child workers from reading parent or sibling transcripts while allowing integrity auditors to inspect worker trajectories.

![Parent transcript access precedence and capability grants](assets/transcript-access-governance.svg)

### 1. CLI Control (`agy-context transcript access` / `policy`)

```bash
# Check active policy status (shorthand: status)
agy-context transcript access --status
agy-context transcript policy status

# Deny transcript access to all child subagents and /swarm workers (shorthand: off)
agy-context transcript access --off

# Restrict children to reading only their own conversation transcript (shorthand: self-only)
agy-context transcript access --self-only

# Allow Agy-Squad flat auditors via @roster* prefix globs while blocking other children
agy-context transcript access --mode allowlist --allow @audit-squad*,@verifier

# Deny specific workers or set a custom TTL in seconds
agy-context transcript access --mode open --deny @worker* --ttl 1800

# Restore open access for the parent cohort CLI policy (shorthands: on, reset)
# Clears policies[ownerId] overrides only; Tier 4 launch directives stay enforced
agy-context transcript access --on
```

### 2. First-Line Launch Directives

To scope an individual child at launch without changing the cohort-wide CLI policy, place a directive on the **first non-empty line** of a `define_subagent` `SystemPrompt`, `invoke_subagent` `Prompt`, or `/swarm` `brief`:

- `[agy-transcript-access: deny]`: blocks all `agy-context transcript` commands for that child.
- `[agy-transcript-access: self-only]`: restricts that child to its own `<callerConvId>` transcript (disabling `list`/`ls` and cross-session `--file` paths outside `<brainDir>/<callerConvId>`).
- `[agy-transcript-access: allow]`: allows transcript reads for that child even when the cohort default mode is `deny` or `self-only` (unless overridden by an explicit CLI `--deny`).

The lineage parser checks only the first non-empty line of the child's initial assignment (`Step 0` / `Step 1`), ignoring directives mentioned in later paragraphs or code blocks.

### 3. 5-Tier Precedence Order

| Tier | Rule | Behavior |
| :---: | :--- | :--- |
| **1** | **Policy Owner** | Parent session (`ownerId`) always has full read and policy mutation access |
| **2** | **Explicit CLI `--deny`** | Denies matching `<convId>` or `@roster*` prefix glob immediately |
| **3** | **Explicit CLI `--allow`** | Allows matching `<convId>` or `@roster*` prefix glob (such as `@audit-squad*`) |
| **4** | **First-Line Launch Directive** | Applies `[agy-transcript-access: deny \| self-only \| allow]` from child launch brief |
| **5** | **Cohort Default Mode** | Applies base policy mode (`open`, `allowlist`, `self-only`, or `deny`) |

### 4. Stale-Lock Protection & Runtime Hardening

- **1-hour TTL, immutable Tier 4 directives, and status visibility:** Parent CLI policies live under `policies[ownerId]` in `<stateDir>/transcript-access.json` with a 3600-second default TTL. Running `--on` / `--reset` clears the parent's `policies[ownerId]` overrides (Tiers 2, 3, and 5) without erasing Tier 4 `[agy-transcript-access: deny | self-only]` launch directives stored on child session files. Both `agy-context transcript access --status` and `agy-context status` preserve parent policy fields and append `launchRestrictions` disclosing recently active (`300s` window) launch-restricted child sessions alongside `policies[ownerId]`.
- **Top-level session bypass:** A root user conversation (`Step 0` is `USER_INPUT` without a `<SYSTEM_MESSAGE>` `sender=<parentConvId>` header) is never restricted by another session's policy.
- **Single-use capability grants and `--file` containment:** When a restriction is active, `PreToolUse` writes a 10-second single-use capability token to `<stateDir>/transcript-access.json`: read grants (`lastHookGrant`) bind `callerConvId`, canonical `subcommand`, `targetConvId`, and `mode`, while policy mutation grants (`lastAccessMutationGrant`) bind `callerConvId`. `lib/transcript-core.mjs` verifies all bound fields, clears the disk token on verification, clears the in-memory grant synchronously upon path resolution (before async stream I/O begins) and on any early error, and independently restricts `--file` to `<brainDir>/<callerConvId>` in `self-only` mode and `<brainDir>` under any active policy or launch restriction. These controls provide application-layer `PreToolUse` and CLI defense-in-depth rather than an OS-kernel sandbox.
- **Child lifecycle and file protection:** Restricted children cannot run `setup`, `install`, `uninstall`, or `restore-backups`, and cannot modify `~/.gemini/config/plugins/agy-context-saver/`, `~/.gemini/config/scripts/execution-guard-hook.mjs`, `hooks.json`, or `<stateDir>/transcript-access.json`.

---

## Safety Invariants

1. **Foreign configuration preservation:** Existing third-party hooks in `~/.gemini/config/hooks.json` and third-party MCP servers in `~/.gemini/config/mcp_config.json` remain untouched during setup and uninstall.
2. **Timestamped backups:** Modifying global `hooks.json` or cleaning stale `agy-context-saver*` entries from `mcp_config.json` writes `.bak` backups first.
3. **Fail-closed on governed tools:** If an unexpected error occurs while evaluating a governed tool (`run_command`, `read_file`, `edit_file`, `write_file`, `manage_task`, `schedule`), the hook returns `decision: "deny"`.
