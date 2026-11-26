# Lifecycle Governance & Hooks

The single global `PreToolUse` hook (`agy-context-saver`, registered in `~/.gemini/config/hooks.json` and routed via `scripts/execution-guard-hook.mjs` into lazy-loaded `scripts/hook/{file,shell,task,transcript}-guard.mjs` modules) evaluates tool calls before Antigravity executes shell commands, file reads/writes, or background task checks.

![PreToolUse hook interception flow](assets/hook-interception-flow.svg)

---

## 3-Layer Governance Rules

### Layer 1: Reactive Lifecycle & Polling Backoff

#### 1. Pure Yield Default, Per-Task Exponential Backoff & Opt-In Watchdogs
Instead of polling `manage_task(Action='status')` in loops or firing intermediate timers on routine local builds, agents default to **Pure Yield** and end their turn immediately (no `schedule` timer, no Pre-Yield Status Card) and letting **Reactive Wakeup** (`<SYSTEM_MESSAGE>`) resume execution once on process exit. Diagnostic status checks and opt-in conditioned stall watchdogs are tracked per task (`session.taskBackoff[taskKey]`, automatically pruned when `getTaskState()` reports `COMPLETED` or past TTL, with flat `session.pollCount` kept only as a fallback for unkeyed calls) along an exponential cooldown curve:

$$\text{requiredBackoffSeconds} = \min\left(600, \text{round}\left(30 \times 2.5^{\max(0, \text{pollCount} - 1)}\right)\right)$$

| Check # | Required Cooldown | Purpose | Action if Premature |
| :---: | :---: | :--- | :--- |
| **Check 1** | **0s (immediate)** | Initial check upon launch (isolated per task) | **Allowed** (`pollCount = 1`) |
| **Check 2** | **30s** | Check for fast tasks | **Denied** with remaining cooldown and Pure Yield guidance |
| **Check 3** | **75s** | Standard build progress | **Denied** with remaining cooldown and Pure Yield guidance |
| **Check 4** | **188s** | Test suite check | **Denied** with remaining cooldown and Pure Yield guidance |
| **Check 5** | **469s** | Long build or hung process | **Denied** with remaining cooldown and Pure Yield guidance |
| **Check 6+** | **600s** | Prolonged process | **Denied**; trips `force_ask` circuit breaker at 5 denials |

- **Immediate operations:** `manage_task(Action='kill')` and `manage_task(Action='send_input')` are always allowed immediately (`0s` cooldown, zero penalties).
- **Blocking CI watch loops denied & remote CI timers:** `gh pr checks --watch` / `-w` and `gh run watch` inside `run_command` are denied because CI runner queues can hang indefinitely; run one-shot snapshots (`gh pr checks`, `gh run list`) paired with backoff-compliant remote CI `schedule` timers (`DurationSeconds >= 30`, scaling `30s -> 75s -> 188s -> 469s -> 600s`, auto-clamping `15..required-1`; no local `task-X` `TimerCondition` required).
- **Pure Yield default vs. opt-in conditioned task watchdogs:** For routine local background `run_command` jobs, yield immediately without calling `schedule` or printing a Pre-Yield Status Card. On unattended `/goal` runs or hang-prone jobs, agents may opt into a conditioned watchdog (`schedule(DurationSeconds=<N>, TimerCondition="<convId>/task-X")`, recommended `45-60s` for quick/hang-risk scripts, `120-180s` for full local test suites/builds, `300-600s` for heavy E2E/Docker sweeps). Perform an immediate Check #1 (`0s`) *before* arming `schedule` if needed (once `schedule` arms a watchdog, Check #1 waits for that watchdog cooldown by design). Conditioned task watchdogs with `DurationSeconds >= 15` shorter than the task's current required backoff (`30s -> 75s -> 188s -> 469s -> 600s`) auto-clamp via `overwrite: { DurationSeconds: requiredBackoffSeconds }`; abusive micro-polls (`< 15s`) and unconditioned task polling loops remain hard-denied.
- **Direct `invoke_subagent` stall watchdogs vs. `/swarm` ban:** One-shot `schedule` timers polling a `/swarm`, squad, or board remain strictly denied (`swarm_wait` sleeps at zero token cost while `swarm_monitor` `*/3` handles stall detection; conditioned `task-*` watchdogs are exempt from `/swarm` keyword collisions). Direct `invoke_subagent` runs may optionally arm a conditioned stall-safety watchdog bound to that specific subagent conversation ID (`TimerCondition="<subagentConvId>"`, not `any` or `never`), scaling `180s -> 450s -> 600s` per subagent ID (recommended `180s-300s`; `30s..179s` auto-clamp to the required floor, while `< 30s` or unconditioned subagent polling is hard-denied).
- **5-strike circuit breaker:** At 5 cumulative denials across polling or internal state checks, the hook returns `force_ask` to pause execution and prompt the user.
- **Task log lifecycle gating:**
  - *While running:* reading `tasks/<taskId>.log` via file tools or shell commands is **always prohibited** (even once the `manage_task(Action='status')` backoff window has elapsed); inspect progress via `manage_task(Action='status')` or wait for Reactive Wakeup.
  - *When completed:* reading `tasks/<taskId>.log` is allowed via bounded `read_file(StartLine, EndLine <= 150)` or a single unchained `rtk read tasks/<taskId>.log` call (`cat`, and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`, with explicit `--head-lines 150` / `--tail-lines 150` required on `> 45 KiB` logs; bare `tail`, quoted/spaced paths, Windows backslash `head`/`tail`, env-prefixed calls, and unknown-state logs require explicit `rtk read <path>`).

---

### Layer 2: Narrow High-ROI RTK Pre-Gate, File Bounds & State Protection

1. **Narrow High-ROI RTK Pre-Gate:** `run_command` segments delegate to `rtk hook antigravity` only for noisy test, build, lint, container, and `git status`/`push`/`pull`/`fetch` runners (plus `npm`/`pnpm` `lint` & `run lint`, `pnpm install`/`outdated`/`tsc`/`list`, `bun test`/`build`/`install`/`add`, and scoped internal spillover/completed task-log `cat`/`head`/`tail` reads), configurable via `AGY_RTK_MODE=pregate|off` (default `pregate`; `2>&1` and `2>/dev/null` stderr redirects pass through). Precision inspection commands (`find`, `grep`, `rg`, `ls`, `wc`, `diff`, `ps`, `git diff`/`show`/`log`, workspace `cat`/`head`/`tail`), generic `npm`/`pnpm`/`bun` `run` scripts, pipes, stdout/file redirects, machine-readable flags (`--json`, `--porcelain`, `git status -sb`, `-o json`, etc.), any explicit `--reporter`/`--reporters` flag on `vitest`/`jest`, global-`PATH`-shadowed `npx`/`bunx`/`pnpm tsc` local binaries, and `vitest >= 5` projects on RTK `< 1.2.0` (`1.1.0`) run natively and losslessly without spawning `rtk`.
2. **Workspace file bounds & native discovery:** Native `grep_search`, `find_by_name`, and `list_dir` are allowed on workspace paths (while remaining blocked on `getStateDir()` and protected brain roots). For `read_file` / `view_file`: files `<= 800` lines and `<= 45 KiB`, safe workspace multimodal media (`.png`, `.jpg`, `.webp`, `.pdf`, audio/video), and Antigravity special files (`SKILL.md`, `AGENTS.md`, own brain artifacts, own `.system_generated/swarm/plan.json`, `swarm_view/`, `.gemini/config/`) pass without slice bounds; larger files (`> 800` lines or `> 45 KiB`) deny omitted bounds and accept explicit `StartLine`/`EndLine` slices up to `800` lines (EOF-clamped via `1 MiB` newline scan, single-bound supported). `read_many_files` and `ByteOffset`-only reads remain denied. The Swarm UI Overview allowlist (`<ownBrainDir>/.system_generated/swarm/plan.json`) applies strictly to single-file `read_file`/`view_file`/`write_file`/`edit_file` on the active session's own non-symlink path (symlinks, sibling sessions, other `.system_generated/` files, `ByteOffset`-only reads, `read_many_files`, and discovery tools stay denied).
3. **Step output spillovers:** `.system_generated/steps/<step>/output.txt` files are readable via bounded `read_file(StartLine, EndLine <= 150)` or a single unchained `rtk read <path>` command (`cat`, and single unquoted forward-slash `head -n <N>` / `tail -n <N>` auto-rewrite via `rtk`; explicit `--head-lines 150` / `--tail-lines 150` required above `45 KiB`).
4. **Transcript write protection, brain subdirs & state protection:** Writes and deletes to `.system_generated/logs/transcript*` and direct file or shell access (including via `multi_replace_file_content` or symlinks) to `getStateDir()` (`~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows) are blocked, while native reads of `transcript.jsonl` follow the transcript mode below. Inside a conversation's brain directory (`<brainDir>/<convId>/`), user-owned `scratch/`, `browser_sandbox/`, and `swarm_view/` subtrees allow nested `logs/`, `tasks/`, and `steps/` paths (while `..` traversal, `$`, dotfiles, and `.system_generated/` writes remain denied), and direct shell artifact operations allow safe extensions (`.md`, `.txt`, `.json`, `.csv`, `.tsv`, `.yaml`, `.yml`, `.xml`, `.zip`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.html`, `.css`, `.webp`, `.bmp`, `.ico`, `.pdf`, `.mp3`, `.wav`, `.mp4`, `.webm`, `.mov`) while keeping `.jsonl`, `.log`, dotfiles, and bare brain directories denied.

---

### Layer 3: Synchronous Execution & Benchmark Integrity

1. **10s synchronous window:** On non-daemon `run_command` calls where `WaitMsBeforeAsync` is omitted, the hook sets `WaitMsBeforeAsync` to `10,000ms` while preserving explicit caller timeouts.
2. **Benchmark file protection:** Edits or writes targeting `benchmarks/`, `evaluation/`, `evaluators/`, `scoring/`, `ground_truth/`, or `prompt_templates/` require `force_ask` user confirmation by default to prevent evaluation contamination. For normal application repositories that contain source directories with those names, set `AGY_DISABLE_BENCHMARK_GUARD=1` in your shell or IDE environment to disable this prompt for unrestricted sessions (child sessions under a restrictive transcript policy keep benchmark protection active).

---

## Configuration and State Protection

- **Protected state:** Writes and deletes under `.system_generated/logs` are denied in every transcript mode. Direct file or shell access to `getStateDir()` stays blocked.
- **Configuration edits:** Top-level sessions (not a child, not under a restrictive transcript policy) get a confirmation prompt (`force_ask`) for non-symlink edits to `~/.gemini/{config,antigravity*}/{mcp_config.json,config.json}`, via native file edits or non-destructive shell edits (supporting `/plugin`, `/migrate-agent-settings`, and MCP setup). Child sessions are hard-denied from those edits. Global `~/.gemini/config/hooks.json`, `*.bak` backups, `~/.gemini/config/plugins/agy-context-saver/` (plugin and hook source), symlinks, and destructive shell verbs (`rm`, `mv`, `ln`, `truncate`, `shred`, `dd`, `chmod`, `chown`, `find`) are hard-denied for everyone.
- **Scope:** These controls are application-layer `PreToolUse` guardrails, not an OS-kernel sandbox.

---

## Transcript Isolation

A parent session can limit which transcripts the sessions it launches may read. The default is `open`, so nothing changes until a parent opts in.

```bash
agy-context transcript access            # show the current policy
agy-context transcript access set self-only
```

| Mode | What a child session may read | Notes |
| :--- | :--- | :--- |
| **`open`** (default) | Any `transcript.jsonl` or `transcript_full.jsonl`, using bounded `read_file` slices, `grep_search`, or read-only shell commands such as `head`, `tail`, `rg`, `grep`, `jq`, and `wc`. | The hook skips the transcript check when no restrictive policy exists, so it costs nothing. |
| **`self-only`** | Only its own transcript. | Sibling, parent, glob, and symlink paths are denied. Health checks allow only its own UUID or `current`; `--parent` is denied. |
| **`deny`** | No transcripts. | Child sessions cannot read any transcript file. |

How it works:

- **Parent-set:** The session that runs `set` becomes the owner. The policy applies to the sessions it launched (its descendants, found from the sender id in each child's first system message). The nearest ancestor's policy wins. The setting never restricts the session that set it.
- **Hook-enforced:** `scripts/hook/transcript-guard.mjs` checks `read_file`, `view_file`, `read_many_files`, `grep_search`, `find_by_name`, `list_dir`, and `run_command`. It resolves real paths, so symlinks cannot bypass it.
- **Fail-closed:** While any restrictive policy exists, a caller that cannot be identified uses the strictest active mode.
- **Tamper-resistant storage:** The policy lives in one small file, `transcript-policy.json`, in the plugin state directory (`{"version":1,"policies":{"<ownerConvId>":{"mode":"..."}}}`). Only the CLI writes it, and the hook denies native and shell writes to it.
- **Scope:** This is application-layer defense in depth, not a sandbox. It does not stop a determined process outside the hook from reading files on disk.

---

## Safety Invariants

1. **Foreign configuration preservation:** Existing third-party hooks in `~/.gemini/config/hooks.json` and third-party MCP servers in `~/.gemini/config/mcp_config.json` remain untouched during setup, uninstall, and backup restoration.
2. **Namespaced, non-clobbering backups:** Modifying global `hooks.json` or cleaning stale `agy-context-saver*` entries from `mcp_config.json` writes namespaced backups (`hooks.json.agy-context-saver.bak` and `mcp_config.json.agy-context-saver.bak`) first; restores validate JSON before key-merging so other installed plugins' hooks and MCP servers are never overwritten.
3. **Fail-closed on governed tools:** If an unexpected error occurs while evaluating a governed tool (`run_command`, `read_file`, `edit_file`, `write_file`, `manage_task`, `schedule`), the hook returns `decision: "deny"`.

## Transcript command identity

The hook adds a random identity token only to a simple, verified transcript access or health command. The CLI consumes its protected state record once, within 15 seconds, and uses the hook's session ID and active transcript root instead of any inherited session environment variable. Invalid, expired, or reused tokens fail closed. Terminal calls without a token can use `GEMINI_CONVERSATION_ID`.

Only top-level sessions may manage transcript access. The health library checks the caller's inherited policy before opening any transcript: `deny` blocks all reads, and `self-only` permits only the caller's own session. Unresolved launch headers, missing ancestors, cycles, and excessive ancestry depth fail closed while a restrictive policy exists. Concurrent policy updates share a lock; resetting the last policy to `open` removes the state file and restores the hook's import-free path.
