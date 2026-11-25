# Security Policy

## Supported releases

Security fixes target the latest release (`2.3.x`).

## Reporting a vulnerability

Do **not** report exploitable details in a public issue or pull request.

Use GitHub's **private vulnerability reporting** from this repository's Security tab. Include the affected version or commit, operating system, Node.js version, impact, minimal reproduction steps, and redacted logs. Never attach raw Antigravity transcript files or user credentials.

## Response targets

Maintainers aim to acknowledge reports within 7 calendar days and provide a status update within 14 calendar days. Please allow time for triage and a coordinated fix before public disclosure.

## Security-sensitive areas

`Agy-Context-Saver` installs a `PreToolUse` hook, updates user-level Antigravity configuration files, provisions the `rtk` binary with SHA-256 verification, and reports read-only session health from local transcripts.

### Hook security architecture (`v2.3.x`)

`scripts/execution-guard-hook.mjs` (routing dynamically to `scripts/hook/file-guard.mjs`, `scripts/hook/shell-guard.mjs`, and `scripts/hook/task-guard.mjs`) and `lib/path-guards.mjs` provide **application-layer defense-in-depth** at the Antigravity `PreToolUse` hook layer rather than an OS-kernel sandbox (`seccomp`, `Landlock`, or container namespace isolation). Within that narrow boundary, they guard accidental bloat, writes to internal state, symlinks, and simple shell wrappers (`sh -c`, `bash -c`, `cmd /c`), without attempting obfuscation decoding or multi-language static analysis.

- **Transcript isolation:** By default (`open`), sessions can read `transcript.jsonl` natively. A parent session can run `agy-context transcript access set self-only|deny` to limit the sessions it launched (its descendants) to their own transcript or none. `scripts/hook/transcript-guard.mjs` enforces this for file tools and shell commands using real paths, fails closed to `self-only` for callers it cannot identify while a restrictive policy exists, and denies native and shell writes to `transcript-policy.json`. This is application-layer defense in depth, not a sandbox: it does not stop processes outside the hook. Treat transcript files as sensitive and never attach them to public issues.
- **State and log protection:** Writes and deletes under `.system_generated/logs` and direct file or shell access to `getStateDir()` (`~/.local/state/agy-context-saver` on POSIX or `%LOCALAPPDATA%\agy-context-saver` on Windows) are blocked. `--out`-style symlink containment uses the shared `resolveRealOrAncestorPath()` helper in `lib/path-guards.mjs`.
- **Own-session Swarm UI Overview allowlist:** Only `<ownBrainDir>/.system_generated/swarm/plan.json` is exempted for single-file `read_file`, `view_file`, `write_file`, and `edit_file` after verifying both resolved and canonical paths and rejecting any symlink along `<convId>`, `.system_generated`, `swarm`, or `plan.json`.
- **User configuration boundary:** Non-symlink, non-destructive edits to `~/.gemini/{config,antigravity*}/{mcp_config.json,config.json}` prompt via `force_ask` for top-level sessions (not a child, not under a restrictive transcript policy) and are hard-denied for child sessions. Global `hooks.json` (the live enforcement boundary), `*.bak` backups, ACS plugin and hook files, symlinks, and destructive shell verbs (`rm`, `mv`, `ln`, `truncate`, `shred`, `dd`, `chmod`, `chown`, `find`) stay hard-`deny`.
- **Brain subdir carve-out:** User-owned `scratch/`, `browser_sandbox/`, and `swarm_view/` subtrees are exempt from `logs/`, `tasks/`, and `steps/` denials while `..` traversal, `$` expansion, dotfiles, and `.system_generated/` writes stay denied.
- **5-strike circuit breaker:** Five cumulative blocked attempts trip the `force_ask` circuit breaker.
