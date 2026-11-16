# Security Policy

## Supported releases

Security fixes target the latest release (`2.0.x`).

## Reporting a vulnerability

Do **not** report exploitable details in a public issue or pull request.

Use GitHub's **private vulnerability reporting** from this repository's Security tab. Include the affected version or commit, operating system, Node.js version, impact, minimal reproduction steps, and redacted logs. Never attach raw Antigravity transcript files or user credentials.

## Response targets

Maintainers aim to acknowledge reports within 7 calendar days and provide a status update within 14 calendar days. Please allow time for triage and a coordinated fix before public disclosure.

## Security-sensitive areas

`Agy-Context-Saver` installs a `PreToolUse` hook, updates user-level Antigravity configuration files, provisions the `rtk` binary with SHA-256 verification, and inspects local session transcripts.

### Transcript access & hook security architecture (`v2.0.1`)

`scripts/execution-guard-hook.mjs` and `lib/transcript-core.mjs` provide **application-layer defense-in-depth** at the Antigravity `PreToolUse` hook and CLI layers rather than an OS-kernel sandbox (`seccomp`, `Landlock`, or container namespace isolation). Within that boundary, they enforce the following controls so restricted child subagents (`EnableWriteTools: true`) and `/swarm` workers cannot read unauthorized transcripts or tamper with governance state:

- **Operation-bound, single-use `PreToolUse` capability grants (`lib/transcript-core.mjs`):** Authorized `agy-context transcript` reads receive a 10-second single-use disk capability token (`lastHookGrant`) bound to the caller's `conversationId`, canonical `subcommand` (`read`, `query`, `step`, `health`, `list`, `export`), `targetConvId` (or `multi:...` when listing/filtering multiple conversations), and access `mode`, while parent `transcript access` updates receive a 10-second single-use mutation token (`lastAccessMutationGrant`) bound to `callerConvId`. `lib/transcript-core.mjs` verifies these fields, consumes the disk token immediately on verification, and clears the in-memory grant synchronously upon path resolution (before async stream I/O begins) and on any early error, blocking direct `node bin/agy-context.mjs` invocations, library imports, concurrent `Promise.all` or same-process reuse, mismatched subcommand or target calls, and chained commands.
- **Independent `--id` and `--file` containment (`lib/transcript-core.mjs`, `scripts/execution-guard-hook.mjs`):** `--id` always enforces `fs.realpathSync` containment inside `getBrainDir()`. While `--file` allows operator-specified `.jsonl` paths in default `open` mode, `resolveTranscriptPath()` in `lib/transcript-core.mjs` (in addition to `PreToolUse`) independently restricts `--file` to `<brainDir>/<callerConvId>` in `self-only` mode and to `<brainDir>` whenever any parent transcript access policy or first-line launch restriction (`[agy-transcript-access: deny|self-only]`) is active.
- **State directory protection (`getStateDir()`):** Direct file tool (`read_file`, `edit_file`, `write_file`) and shell access to `getStateDir()` (`~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows, including `transcript-access.json` and `agy-session-*.json`) is blocked, and environment variable overrides (`XDG_STATE_HOME`, `LOCALAPPDATA`, `AGY_TEST_PROFILE_DIR`, `AGY_BRAIN_DIR`, `GEMINI_CONVERSATION_ID`) inside shell commands or scripts are rejected.
- **Executable script and heredoc scanning:** When `edit_file` or `write_file` writes executable scripts (`.mjs`, `.js`, `.cjs`, `.sh`, `.bash`, `.py`, `.ps1`) or when `run_command` executes inline interpreters (`node -e`, `python -c`), heredocs, or subshells, the hook scans the content for `.system_generated`, `transcript.jsonl`, `transcript_full.jsonl`, `transcript-core.mjs`, `bin/agy-context.mjs`, and `getStateDir()` references.
- **Parent transcript access governance:**
  - **5-tier precedence:** `1. Policy Owner` -> `2. Explicit CLI --deny` -> `3. Explicit CLI --allow` (supporting `@roster*` prefix globs such as `@audit-squad*`) -> `4. First-Line Launch Directive` (`[agy-transcript-access: deny|self-only|allow]` on the first non-empty line of a `SystemPrompt`, `Prompt`, or `brief`) -> `5. Cohort Default Mode` (`open`, `allowlist`, `self-only`, or `deny`).
  - **Stale-lock protection:** Policies are keyed per parent (`policies[ownerId]`) with a 1-hour default TTL, Step 0 `USER_INPUT` top-level user sessions bypass foreign parent locks automatically, Step 0/1 `sender=<parentConvId>` binds child agents to their parent policy, and `agy-context status` displays the active `Transcript Access Policy`.
- **Context-aware denials and 5-strike circuit breaker:** When transcript access is restricted for a caller, `.system_generated` denial messages omit `agy-context transcript` retry hints, and 5 cumulative blocked attempts trip the `force_ask` circuit breaker.
