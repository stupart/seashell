#!/bin/bash
set -e

# Sea Shell Installer
# Local speech-to-text using Whisper

echo "Installing Sea Shell..."
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check for required tools
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "Error: $1 is required but not installed."
        echo "$2"
        exit 1
    fi
}

# Check dependencies
check_command "bun" "Install Bun: curl -fsSL https://bun.sh/install | bash"
check_command "sox" "Install sox: brew install sox"
check_command "cmake" "Install cmake: brew install cmake"
check_command "git" "Install git: xcode-select --install"

echo "All dependencies found."
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

# VAD model for voice detection
if [ ! -f "whisper.cpp/models/ggml-silero-v6.2.0.bin" ]; then
    echo "Downloading Silero VAD model..."
    curl -L -o whisper.cpp/models/ggml-silero-v6.2.0.bin \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-silero-v6.2.0.bin"
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

# Try /usr/local/bin first, fall back to ~/bin
if [ -w "/usr/local/bin" ]; then
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
echo "Installation complete!"
echo ""
echo "Usage:"
echo "  seashell     - Start speech-to-text"
echo ""
echo "Controls:"
echo "  [SPACE]  Pause/Resume"
echo "  [C]      Copy transcript"
echo "  [DEL]    Clear transcript"
echo "  [Q]      Quit"
