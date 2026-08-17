#!/bin/bash
set -euo pipefail

# Sea Shell Installer
# Local speech-to-text using Whisper

echo "Installing Sea Shell..."
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

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

# Build the native macOS 14.2+ system-audio helper used by live meeting capture.
SYSTEM_AUDIO_SOURCE="native/macos-system-audio.swift"
SYSTEM_AUDIO_ATOMIC_SOURCE="native/seashell-atomic.c"
SYSTEM_AUDIO_ATOMIC_HEADER="native/seashell-atomic.h"
SYSTEM_AUDIO_BINARY="native/bin/seashell-system-audio"
MEETING_SIGNALS_SOURCE="native/macos-meeting-signals.swift"
MEETING_SIGNALS_BINARY="native/bin/seashell-meeting-signals"
mkdir -p native/bin
if [ ! -x "$SYSTEM_AUDIO_BINARY" ] || [ "$SYSTEM_AUDIO_SOURCE" -nt "$SYSTEM_AUDIO_BINARY" ] || \
   [ "$SYSTEM_AUDIO_ATOMIC_SOURCE" -nt "$SYSTEM_AUDIO_BINARY" ] || \
   [ "$SYSTEM_AUDIO_ATOMIC_HEADER" -nt "$SYSTEM_AUDIO_BINARY" ]; then
    echo "Building native system-audio capture helper..."
    ATOMIC_OBJECT="native/bin/seashell-atomic.o"
    xcrun clang -std=c11 -O2 -c "$SYSTEM_AUDIO_ATOMIC_SOURCE" -o "$ATOMIC_OBJECT"
    xcrun swiftc "$SYSTEM_AUDIO_SOURCE" "$ATOMIC_OBJECT" -O \
        -import-objc-header "$SYSTEM_AUDIO_ATOMIC_HEADER" \
        -framework AVFoundation \
        -framework AudioToolbox \
        -framework CoreAudio \
        -o "$SYSTEM_AUDIO_BINARY"
    rm -f "$ATOMIC_OBJECT"
fi

if [ ! -x "$MEETING_SIGNALS_BINARY" ] || [ "$MEETING_SIGNALS_SOURCE" -nt "$MEETING_SIGNALS_BINARY" ]; then
    echo "Building native meeting-signal helper..."
    xcrun swiftc "$MEETING_SIGNALS_SOURCE" -O \
        -framework AppKit \
        -framework CoreAudio \
        -o "$MEETING_SIGNALS_BINARY"
fi

echo "Native capture and meeting-signal helpers built successfully."
echo ""

# Clone and build whisper.cpp
if [ ! -d "whisper.cpp" ]; then
    echo "Cloning whisper.cpp..."
    git clone https://github.com/ggerganov/whisper.cpp.git
fi

if [ ! -f "whisper.cpp/build/bin/whisper-cli" ]; then
    echo "Building whisper.cpp with Metal support..."
    cd whisper.cpp
    cmake -B build -DGGML_METAL=ON
    cmake --build build --config Release -j
    cd ..
fi

echo "whisper.cpp built successfully."
echo ""

# Download models
mkdir -p models
mkdir -p whisper.cpp/models

# Main transcription model
if [ ! -f "models/ggml-large-v3-turbo-q5_0.bin" ]; then
    echo "Downloading Whisper large-v3-turbo model (547MB)..."
    curl -L -o models/ggml-large-v3-turbo-q5_0.bin \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
fi

# VAD model for voice detection (check size - whisper.cpp has a tiny placeholder file)
VAD_MODEL="whisper.cpp/models/ggml-silero-v6.2.0.bin"
VAD_SIZE=$(stat -f%z "$VAD_MODEL" 2>/dev/null || echo "0")
if [ "$VAD_SIZE" -lt 100000 ]; then
    echo "Downloading Silero VAD model..."
    curl -L -o "$VAD_MODEL" \
        "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin"
fi

echo "Models downloaded."
echo ""

# Install Node dependencies
echo "Installing dependencies..."
bun install

# Make seashell executable
chmod +x seashell

# Create symlink for global access
echo ""
echo "Creating global 'seashell' command..."

# Prefer an existing Homebrew bin directory because it is normally already on PATH.
BREW_BIN=""
if command -v brew &> /dev/null; then
    BREW_BIN="$(brew --prefix)/bin"
fi
if [ -n "$BREW_BIN" ] && [ -d "$BREW_BIN" ] && [ -w "$BREW_BIN" ]; then
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
