# Installation & Setup

`Agy-Context-Saver` can be installed in seconds on any operating system without complex toolchains.

---

## Prerequisites

- **Node.js**: Version 22.0.0 or later (`>=22` required; tested on Node 22 and 24 across Windows, macOS, and Linux).
- **Google Antigravity**: Antigravity 2.0+ (Windows, macOS, or Linux).

---

## Installation Methods

### Option 1: NPX Global Registration (Recommended)

The fastest method to install and activate `Agy-Context-Saver`:

```bash
# Register and activate immediately
npx --package=agy-context-saver agy-context setup
```

This automated command:
1. Links the package into your active Antigravity plugins directory (`~/.gemini/config/plugins/agy-context-saver`), activating the bundled single-source `hooks.json` (`agy-context-saver`).
2. Prunes legacy `execution-guard` and duplicate global `hooks.json` entries (with automatic `.bak` backup).
3. Retires default MCP registration by sweeping legacy `agy-context-saver*` keys from `mcp_config.json` and any stale schema caches under `~/.gemini/antigravity/mcp/agy-context-saver*` (preserving all third-party servers).
4. Installs executable `agy-context` and `agy-context-saver` shims into `~/.gemini/antigravity/bin/`.
5. Verifies `rtk >= 1.1.0` on `PATH` and standardizes RTK configuration (`suppress_hook_warning = true`).

> [!NOTE]
> **RTK Default Configuration Notice**: To protect agent context and prevent shell command corruption, `Agy-Context-Saver` standardizes `suppress_hook_warning = true` in RTK's user configuration (`%APPDATA%\rtk\config.toml` on Windows or `~/.config/rtk/config.toml` on POSIX). This completely silences unsolicited upstream promotional banners while non-destructively preserving all existing user settings. See [RTK Support Matrix](RTK-SUPPORT-MATRIX.md) for full details.

### Option 2: Local Repository Setup

If you have cloned or downloaded the repository:

```bash
# Clone the repository
git clone https://github.com/paragon-ux/agy-context-saver.git
cd agy-context-saver

# Run registration
npm run setup
```

Alternatively, use the native shell installer scripts:

=== "Windows (PowerShell)"
    ```powershell
    .\install.ps1
    ```

=== "macOS / Linux (Bash)"
    ```bash
    chmod +x install.sh
    ./install.sh
    ```

### Option 3: Deprecated Legacy MCP Compatibility Wrapper

Default MCP registration was retired in v2.0.0 in favor of the zero-overhead `agy-context` CLI. Only if a legacy external host explicitly requires JSON-RPC stdio compatibility over `lib/transcript-core.mjs`:

```json
{
  "mcpServers": {
    "agy-context-saver": {
      "command": "node",
      "args": ["/path/to/agy-context-saver/mcp/index.js"]
    }
  }
}
```

---

## Health Auditing & Verification

You can audit all v2.0.0 integration layers at any time from your shell:

```bash
agy-context status
# or
npm run status
```

Output:
```
Checking Agy-Context-Saver installation status...
- Native Plugin Link: ACTIVE (~/.gemini/config/plugins/agy-context-saver)
- Execution Governor Hook (agy-context-saver): ACTIVE (plugin hooks.json)
- CLI Shim (agy-context): INSTALLED (~/.gemini/antigravity/bin)
- RTK Command Optimizer (>= 1.1.0): INSTALLED (rtk 1.1.0)
- MCP Cleanup: CLEAN (0 duplicate MCP configs/schemas)
Overall Status: HEALTHY & ACTIVE
```

---

## Clean Uninstallation & Rollback

`Agy-Context-Saver` provides a strict clean-room uninstallation mechanism:

```bash
# Standard clean uninstallation (preserves non-Agy configurations)
npm run uninstall

# Clean uninstallation with full backup file restoration
node scripts/install-register.mjs --uninstall --restore-backups
```
