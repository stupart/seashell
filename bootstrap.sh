#!/bin/bash
set -euo pipefail

REPOSITORY_URL="${SEASHELL_REPOSITORY_URL:-https://github.com/stupart/seashell.git}"
INSTALL_ROOT="${SEASHELL_INSTALL_DIR:-${HOME}/.local/share/seashell}"

if ! command -v git &> /dev/null; then
    echo "Sea Shell needs Apple's Command Line Tools. Starting their installer..."
    xcode-select --install 2>/dev/null || true
    echo "Finish that macOS installation, then run this command again."
    exit 1
fi

if [ -e "$INSTALL_ROOT" ]; then
    if [ ! -d "$INSTALL_ROOT/.git" ] || [ ! -x "$INSTALL_ROOT/install.sh" ]; then
        echo "Install path already exists and is not a Sea Shell checkout: $INSTALL_ROOT" >&2
        echo "Choose another path with SEASHELL_INSTALL_DIR." >&2
        exit 1
    fi
    if [ -n "$(git -C "$INSTALL_ROOT" status --porcelain)" ]; then
        echo "Sea Shell has local changes at $INSTALL_ROOT; preserving them." >&2
        echo "Commit or move those changes, then run seashell update." >&2
        exit 1
    fi
    echo "Updating the existing Sea Shell checkout..."
    git -C "$INSTALL_ROOT" pull --ff-only
else
    mkdir -p "$(dirname "$INSTALL_ROOT")"
    git clone "$REPOSITORY_URL" "$INSTALL_ROOT"
fi

exec "$INSTALL_ROOT/install.sh"
