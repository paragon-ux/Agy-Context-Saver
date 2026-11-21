# Security Policy

## Supported releases

Security fixes target the latest release (`2.1.x`).

## Reporting a vulnerability

Do **not** report exploitable details in a public issue or pull request.

Use GitHub's **private vulnerability reporting** from this repository's Security tab. Include the affected version or commit, operating system, Node.js version, impact, minimal reproduction steps, and redacted logs. Never attach raw Antigravity transcript files or user credentials.

## Response targets

Maintainers aim to acknowledge reports within 7 calendar days and provide a status update within 14 calendar days. Please allow time for triage and a coordinated fix before public disclosure.

## Security-sensitive areas

`Agy-Context-Saver` installs a `PreToolUse` hook, updates user-level Antigravity configuration files, provisions the `rtk` binary with SHA-256 verification, and inspects local session transcripts.

### Transcript access & hook security architecture (`v2.1.x`)

`scripts/execution-guard-hook.mjs` (routing dynamically to `scripts/hook/file-guard.mjs`, `scripts/hook/shell-guard.mjs`, and `scripts/hook/task-guard.mjs`), `lib/access-policy.mjs`, `lib/path-guards.mjs`, and `lib/transcript-core.mjs` provide **application-layer defense-in-depth** at the Antigravity `PreToolUse` hook and CLI layers rather than an OS-kernel sandbox (`seccomp`, `Landlock`, or container namespace isolation). Within that narrow boundary, they guard accidental bloat, direct internal-state access, symlinks, simple shell wrappers (`sh -c`, `bash -c`, `cmd /c`), and CLI capability grants — without attempting obfuscation decoding or multi-language static analysis, and without blocking unrestricted top-level developer scripts:

- **Operation-bound, single-use `PreToolUse` capability grants (`lib/access-policy.mjs`, `lib/transcript-core.mjs`):** Authorized `agy-context transcript` reads receive a 10-second single-use atomic disk capability grant under `<stateDir>/grants/` bound to the caller's `conversationId`, canonical `subcommand` (`read`, `query`, `step`, `health`, `list`, `export`), `targetConvId` (or `parent:<uuid>` / `multi:<id1,id2,...>` on multi-conversation `export`, while `list` verifies the `list` capability grant without a single `targetConvId`), and access `mode`, while parent `transcript access` updates receive a 10-second single-use mutation grant bound to `callerConvId`. `lib/transcript-core.mjs` atomically claims (`renameSync`) and verifies these fields, unlinks the claimed grant upon path resolution (before async stream I/O begins) and on any subcommand-matched early error, blocking direct `node bin/agy-context.mjs` invocations, library imports, concurrent `Promise.all` or same-process reuse, mismatched subcommand or target calls, and chained commands.
- **Independent `--id`, `--file`, and `--out` symlink containment (`lib/path-guards.mjs`, `lib/transcript-core.mjs`, `scripts/hook/*`):** `--id` always enforces `fs.realpathSync` containment inside `getBrainDir()`, and shared `resolveRealOrAncestorPath()` follows symlinks (including dangling intermediate symlinks) on `--out` export paths and file-tool targets. While `--file` allows operator-specified `.jsonl` paths in default `open` mode, `resolveTranscriptPath()` in `lib/transcript-core.mjs` (in addition to `PreToolUse`) independently restricts `--file` to `<brainDir>/<callerConvId>` in `self-only` mode and to `<brainDir>` whenever any parent transcript access policy or first-line launch restriction (`[agy-transcript-access: deny|self-only]`) is active.
- **State directory protection (`getStateDir()`):** Direct file tool (`read_file`, `edit_file`, `write_file`, `multi_replace_file_content`) and shell access to `getStateDir()` (`~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows, including `transcript-access.json`, `grants/`, and `agy-session-*.json`) is blocked. Inside shell commands, Antigravity environment variable overrides (`AGY_TEST_PROFILE_DIR`, `AGY_BRAIN_DIR`, `GEMINI_CONVERSATION_ID`) are blocked, while `XDG_STATE_HOME` and `LOCALAPPDATA` overrides are blocked in restricted child sessions and whenever a command targets governance or `.gemini` state.
- **Direct shell wrapper & restricted-child import guards:** Simple shell wrappers (`sh -c`, `bash -c`, `cmd /c`) are unwrapped for direct `.system_generated/` and `getStateDir()` checks, and restricted child sessions are blocked from importing or executing `transcript-core.mjs` or `bin/agy-context.mjs` directly, while unrestricted top-level developer scripts execute freely.
- **Parent transcript access governance:**
  - **5-tier precedence:** `1. Policy Owner` -> `2. Explicit CLI --deny` -> `3. Explicit CLI --allow` (supporting `@roster*` prefix globs such as `@reviewer-*`) -> `4. First-Line Launch Directive` (`[agy-transcript-access: deny|self-only|allow]` on the first non-empty line of a `SystemPrompt`, `Prompt`, or `brief`) -> `5. Cohort Default Mode` (`open`, `allowlist`, `self-only`, or `deny`).
  - **Stale-lock protection:** Policies are keyed per parent (`policies[ownerId]`) with a 1-hour default TTL, expired per-conversation `agy-session-*.json` files are automatically pruned past TTL, Step 0 `USER_INPUT` top-level user sessions bypass foreign parent locks automatically, Step 0/1 `sender=<parentConvId>` binds child agents to their parent policy, and `agy-context status` displays the active `Transcript Access Policy`.
- **Context-aware denials and 5-strike circuit breaker:** When transcript access is restricted for a caller, `.system_generated` denial messages omit `agy-context transcript` retry hints, and 5 cumulative blocked attempts trip the `force_ask` circuit breaker.
