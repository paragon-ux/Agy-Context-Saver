#!/usr/bin/env bash
# Agy-Context-Saver Zero-Delay Installer for macOS & Linux
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js (>= 22.0.0) is required, but 'node' was not found on PATH." >&2
  echo "Please install Node.js 22 or newer (https://nodejs.org/ or via nvm/fnm/volta) and re-run ./install.sh." >&2
  exit 1
fi

NODE_VERSION="$(node -v 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Unsupported Node.js version ${NODE_VERSION:-unknown}. Agy-Context-Saver requires Node.js >= 22.0.0." >&2
  echo "Please upgrade Node.js (https://nodejs.org/ or via nvm/fnm/volta) and re-run ./install.sh." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/scripts/install-register.mjs" "$@"
