#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ]; then
    echo "Sea Shell native capture requires macOS." >&2
    exit 1
fi
mkdir -p native/bin
BUILD_DIR="$(mktemp -d native/bin/.build.XXXXXX)"
trap 'rm -rf "$BUILD_DIR"' EXIT
SYSTEM_AUDIO_BINARY=native/bin/seashell-system-audio
if [ ! -x "$SYSTEM_AUDIO_BINARY" ] || \
   [ native/macos-system-audio.swift -nt "$SYSTEM_AUDIO_BINARY" ] || \
   [ native/seashell-atomic.c -nt "$SYSTEM_AUDIO_BINARY" ] || \
   [ native/seashell-atomic.h -nt "$SYSTEM_AUDIO_BINARY" ]; then
    xcrun clang -std=c11 -O2 -c native/seashell-atomic.c -o "$BUILD_DIR/atomic.o"
    xcrun swiftc native/macos-system-audio.swift "$BUILD_DIR/atomic.o" -O \
        -import-objc-header native/seashell-atomic.h \
        -framework AVFoundation -framework AudioToolbox -framework CoreAudio \
        -o "$BUILD_DIR/seashell-system-audio"
    mv -f "$BUILD_DIR/seashell-system-audio" "$SYSTEM_AUDIO_BINARY"
fi
MEETING_SIGNALS_BINARY=native/bin/seashell-meeting-signals
if [ ! -x "$MEETING_SIGNALS_BINARY" ] || \
   [ native/macos-meeting-signals.swift -nt "$MEETING_SIGNALS_BINARY" ]; then
    xcrun swiftc native/macos-meeting-signals.swift -O \
        -framework AppKit -framework CoreAudio -o "$BUILD_DIR/seashell-meeting-signals"
    mv -f "$BUILD_DIR/seashell-meeting-signals" "$MEETING_SIGNALS_BINARY"
fi
MEETING_ACCESSIBILITY_BINARY=native/bin/seashell-meeting-accessibility
if [ ! -x "$MEETING_ACCESSIBILITY_BINARY" ] || \
   [ native/macos-meeting-accessibility.swift -nt "$MEETING_ACCESSIBILITY_BINARY" ]; then
    xcrun swiftc native/macos-meeting-accessibility.swift -O \
        -framework AppKit -framework ApplicationServices \
        -o "$BUILD_DIR/seashell-meeting-accessibility"
    mv -f "$BUILD_DIR/seashell-meeting-accessibility" "$MEETING_ACCESSIBILITY_BINARY"
fi
