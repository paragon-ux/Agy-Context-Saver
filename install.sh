#!/usr/bin/env bash
# Agy-Context-Saver Zero-Delay Installer for macOS & Linux
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/scripts/install-register.mjs" "$@"
