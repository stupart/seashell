#!/bin/bash
set -euo pipefail

# Sea Shell Installer
# Local speech-to-text using Whisper

echo "Installing Sea Shell..."
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
REPAIR=0
if [ "${1:-}" = --repair ]; then REPAIR=1; shift; fi
if [ "$#" -ne 0 ]; then
    echo "Usage: install.sh [--repair]" >&2
    exit 1
fi

if [ "$(uname -s)" != Darwin ]; then
    echo "Sea Shell requires macOS." >&2
    exit 1
fi

# Install ordinary package dependencies when possible, so a normal Homebrew Mac
# needs only this installer command.
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "Error: $1 is required but not installed."
        echo "$2"
        exit 1
    fi
}

check_command "git" "Install git: xcode-select --install"
check_command "xcrun" "Install the Xcode Command Line Tools: xcode-select --install"
if ! xcrun --find clang &> /dev/null || ! xcrun --find swiftc &> /dev/null; then
    echo "Install the Xcode Command Line Tools with xcode-select --install, then retry." >&2
    exit 1
fi

if ! command -v bun &> /dev/null; then
    echo "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="${HOME}/.bun/bin:${PATH}"
fi

BREW_PACKAGES=()
command -v sox &> /dev/null || BREW_PACKAGES+=(sox)
command -v ffmpeg &> /dev/null || BREW_PACKAGES+=(ffmpeg)
command -v ffprobe &> /dev/null || BREW_PACKAGES+=(ffmpeg)
command -v cmake &> /dev/null || BREW_PACKAGES+=(cmake)
if [ "${#BREW_PACKAGES[@]}" -gt 0 ]; then
    check_command "brew" "Install Homebrew from https://brew.sh, then rerun this installer."
    # ffmpeg may have been requested by both binary checks.
    UNIQUE_BREW_PACKAGES=()
    for package in "${BREW_PACKAGES[@]}"; do
        [[ " ${UNIQUE_BREW_PACKAGES[*]} " == *" ${package} "* ]] || UNIQUE_BREW_PACKAGES+=("$package")
    done
    echo "Installing system dependencies: ${UNIQUE_BREW_PACKAGES[*]}"
    brew install "${UNIQUE_BREW_PACKAGES[@]}"
fi

check_command "bun" "Install Bun: curl -fsSL https://bun.sh/install | bash"
check_command "sox" "Install sox: brew install sox"
check_command "ffmpeg" "Install FFmpeg: brew install ffmpeg"
check_command "ffprobe" "Install FFmpeg (includes ffprobe): brew install ffmpeg"
check_command "cmake" "Install cmake: brew install cmake"

echo "All dependencies found."
echo ""

# The same native build runs during installation, updates, and the test gym.
bash scripts/build-native.sh

# Pin the backend so repeat installs do not silently change the ASR engine.
WHISPER_REVISION="927cfce34f31707e17f2bff35c349632fb9e2c3a"
if [ ! -d whisper.cpp ]; then
    git clone --branch v1.9.4 --depth 1 https://github.com/ggml-org/whisper.cpp.git whisper.cpp
fi
if [ "$(git -C whisper.cpp rev-parse HEAD)" != "$WHISPER_REVISION" ]; then
    if [ -n "$(git -C whisper.cpp status --porcelain --untracked-files=no)" ]; then
        echo "whisper.cpp has local changes; preserve them before rerunning the installer." >&2
        exit 1
    fi
    git -C whisper.cpp fetch --depth 1 origin "$WHISPER_REVISION"
    git -C whisper.cpp checkout --detach "$WHISPER_REVISION"
fi
cmake -S whisper.cpp -B whisper.cpp/build -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build whisper.cpp/build --config Release --parallel "$(sysctl -n hw.ncpu)" \
    --target whisper-cli whisper-server

# SHA-256 values are the publishers' LFS object IDs. Never trust presence alone.
bash scripts/download-model.sh models/ggml-large-v3-turbo-q5_0.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin \
    394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2
bash scripts/download-model.sh whisper.cpp/models/ggml-silero-v6.2.0.bin \
    https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin \
    2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987

# Install Node dependencies
echo "Installing dependencies..."
bun install --frozen-lockfile

# Make seashell executable
chmod +x seashell

# Updates repair binaries/models/dependencies without changing login or PATH choices.
if [ "$REPAIR" = 1 ]; then
    echo "Sea Shell runtime repaired. Existing setup preserved."
    exit 0
fi

# Create symlink for global access
echo ""
echo "Creating global 'seashell' command..."

# Prefer an existing Homebrew bin directory because it is normally already on PATH.
BREW_BIN=""
if command -v brew &> /dev/null; then
    BREW_BIN="$(brew --prefix)/bin"
fi
if [ -n "${SEASHELL_BIN_DIR:-}" ]; then
    mkdir -p "$SEASHELL_BIN_DIR"
    ln -sf "$SCRIPT_DIR/seashell" "$SEASHELL_BIN_DIR/seashell"
    echo "Installed to $SEASHELL_BIN_DIR/seashell"
elif [ -n "$BREW_BIN" ] && [ -d "$BREW_BIN" ] && [ -w "$BREW_BIN" ]; then
    ln -sf "$SCRIPT_DIR/seashell" "$BREW_BIN/seashell"
    echo "Installed to $BREW_BIN/seashell"
elif [ -w "/usr/local/bin" ]; then
    ln -sf "$SCRIPT_DIR/seashell" /usr/local/bin/seashell
    echo "Installed to /usr/local/bin/seashell"
else
    mkdir -p "$HOME/bin"
    ln -sf "$SCRIPT_DIR/seashell" "$HOME/bin/seashell"
    echo "Installed to ~/bin/seashell"
    echo ""
    echo "Add ~/bin to your PATH if not already:"
    echo "  echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.zshrc"
fi

echo ""
if [ "${SEASHELL_SKIP_FIRST_RUN:-0}" = "1" ]; then
    echo "Skipping first-install defaults (SEASHELL_SKIP_FIRST_RUN=1)."
else
    SETUP_ARGS=(setup)
    if [ "${SEASHELL_SKIP_AUTOSTART:-0}" = "1" ]; then
        SETUP_ARGS+=(--no-autostart)
    fi
    "$SCRIPT_DIR/seashell" "${SETUP_ARGS[@]}"
fi

echo ""
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  seashell                         - Open live transcription + library"
echo "  seashell video.mp4               - Transcribe any supported media"
echo "  seashell transcribe --help       - See file transcription options"
echo "  seashell doctor                  - Verify the installation"
echo ""
echo "Controls:"
echo "  [SPACE]  Start or pause recording"
echo "  [F]      Import audio or video"
echo "  [H]      Open or close transcript history"
echo "  [T]/[S]  Toggle timestamps/speakers"
echo "  [Q]      Quit"
echo ""
echo "macOS asks for Microphone, Screen & System Audio, and optional Calendar"
echo "permission only when each capability is first used. No cloud key is required."
