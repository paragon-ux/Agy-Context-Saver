# Installation & Setup

`Agy-Context-Saver` can be installed in seconds on any operating system without complex toolchains.

---

## Prerequisites

- **Node.js**: Version 18.0.0 or later (v22.5+ recommended for native SQLite integration).
- **Google Antigravity**: Antigravity 2.0+ (Windows, macOS, or Linux).

---

## Installation Methods

### Option 1: NPX Global Registration (Recommended)

The fastest method to install and activate `Agy-Context-Saver`:

```bash
# Register and activate immediately
npx agy-context-saver install
```

This automated command:
1. Links the package into your active Antigravity plugins directory (`~/.gemini/config/plugins/agy-context-saver`).
2. Registers the `execution-guard` hook in `~/.gemini/config/hooks.json` (with automatic backup).
3. Adds `agy-context-saver` to `~/.gemini/config/mcp_config.json` (with automatic backup).
4. Mirrors all 7 tool schemas into `~/.gemini/antigravity/mcp/agy-context-saver/`.

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

### Option 3: Manual MCP Registration

If you prefer to configure the MCP server manually in `~/.gemini/config/mcp_config.json`:

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

You can audit the complete 4-layer integration status at any time from your shell:

```bash
npm run status
```

Output:
```
🔍 Checking Agy-Context-Saver installation status...
   ✓ Native Plugin Link: ~/.gemini/config/plugins/agy-context-saver
   ✓ Governor Hook: Registered in ~/.gemini/config/hooks.json
   ✓ Universal MCP Server: Configured in ~/.gemini/config/mcp_config.json
   ✓ Antigravity Tool Schemas: Present in ~/.gemini/antigravity/mcp/agy-context-saver

[OK] All 4 installation layers are active and operational.
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
