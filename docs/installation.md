# Installation & Setup

`Agy-Context-Saver` installs across Windows, macOS, and Linux with zero external npm runtime dependencies.

---

## Prerequisites

- **Node.js**: Version 22.0.0 or later (`>=22` required; tested on Node 22 and 24 across Windows, macOS, and Linux).
- **Google Antigravity**: Antigravity 2.0+ (Windows, macOS, or Linux).
- **RTK (`>= 1.1.0`)**: Either pre-installed on `PATH` (`brew install rtk`, `cargo install --locked rtk`, or the official install script) or automatically downloaded into `bin/` during `agy-context setup` and verified against pinned `rtk v1.1.0` SHA-256 release checksums.

---

## Installation Methods

### Option 1: NPX Global Registration (Recommended)

Run the single-command installer to register and activate `Agy-Context-Saver`:

```bash
# Register and activate immediately
npx --package=agy-context-saver agy-context setup
```

This command performs five steps:
1. Links the package into your active Antigravity plugins directory (`~/.gemini/config/plugins/agy-context-saver`) and registers the `agy-context-saver` `PreToolUse` hook in both the plugin `hooks.json` and global `~/.gemini/config/hooks.json` (ensuring coverage across top-level sessions, subagents, and `/swarm` workers).
2. Prunes legacy `execution-guard` entries from global `hooks.json` after creating an automatic `.bak` backup.
3. Retires default MCP registration by removing legacy `agy-context-saver*` keys from `mcp_config.json` and sweeping stale schema caches under `~/.gemini/antigravity/mcp/agy-context-saver*` while preserving all third-party MCP servers.
4. Installs executable `agy-context` and `agy-context-saver` shims into `~/.gemini/antigravity/bin/`.
5. Verifies `rtk >= 1.1.0` on `PATH` and sets `suppress_hook_warning = true` in RTK's configuration.

> [!NOTE]
> **RTK Default Configuration Notice**: To protect agent context and prevent shell command corruption, `Agy-Context-Saver` sets `suppress_hook_warning = true` in RTK's user configuration (`%APPDATA%\rtk\config.toml` on Windows or `~/.config/rtk/config.toml` on POSIX). This silences upstream promotional banners while preserving all existing user settings. See [RTK Support Matrix](RTK-SUPPORT-MATRIX.md) for full details.

### Option 2: Local Repository Setup

If you have cloned the repository locally:

```bash
# Clone the repository
git clone https://github.com/paragon-ux/Agy-Context-Saver.git
cd Agy-Context-Saver

# Run registration
npm run setup
```

You can also run the platform installer scripts directly:

=== "Windows (PowerShell)"
    ```powershell
    .\install.ps1
    ```

=== "macOS / Linux (Bash)"
    ```bash
    chmod +x install.sh
    ./install.sh
    ```

---

## Health Auditing & Verification

Audit all v2.0.x integration layers from your shell:

```bash
agy-context status
# or
npm run status
```

Output:
```text
Checking Agy-Context-Saver installation status...

- Native Plugin Link: ACTIVE (~/.gemini/config/plugins/agy-context-saver)
- Execution Governor Hook (agy-context-saver): ACTIVE (plugin + global hooks.json)
- CLI Shim (agy-context): INSTALLED (~/.gemini/antigravity/bin)
- RTK Command Optimizer (>= 1.1.0): INSTALLED (rtk 1.1.0)
- MCP Cleanup: CLEAN (0 duplicate MCP configs/schemas)
- Transcript Access Policy: OPEN (default)

Overall Status: HEALTHY & ACTIVE
```

When a parent session restricts child transcript inspection via `agy-context transcript access` (for example, `--off`, `--self-only`, or `--mode allowlist`), the `Transcript Access Policy` line reports the active policy mode and owner conversation ID (`DENY (owner: <convId>)` or `SELF-ONLY (owner: <convId>)`).

---

## Clean Uninstallation & Rollback

Remove `Agy-Context-Saver` without disturbing foreign hooks or third-party MCP servers:

```bash
# Standard clean uninstallation (preserves non-Agy configurations)
npm run uninstall

# Clean uninstallation with full backup file restoration
node scripts/install-register.mjs --uninstall --restore-backups
```

### Child Session Lifecycle & Governance Protection

To prevent restricted subagents or `/swarm` workers from disabling governance mid-run, `PreToolUse` blocks restricted child sessions from:
- Running plugin lifecycle commands (`setup`, `install`, `uninstall`, `restore-backups`, `--setup`, `--install`, `--uninstall`, `--restore-backups`) via `agy-context` or `scripts/install-register.mjs`.
- Mutating installed or repository governance files (`~/.gemini/config/plugins/agy-context-saver/`, `~/.gemini/config/scripts/execution-guard-hook.mjs`, `hooks.json`, and `<stateDir>/transcript-access.json`) via file tools, shell redirects, in-place editors (`sed -i`, `perl`, `chmod`, `ln`, `dd`, `patch`), or script interpreters.
