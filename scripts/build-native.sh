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
MICROPHONE_BINARY=native/bin/seashell-microphone
if [ ! -x "$MICROPHONE_BINARY" ] || \
   [ native/macos-microphone.swift -nt "$MICROPHONE_BINARY" ] || \
   [ native/macos-microphone-Info.plist -nt "$MICROPHONE_BINARY" ]; then
    # The embedded Info.plist supplies the usage string macOS requires before
    # it will ask for Microphone access on this helper's own behalf. A fixed
    # module name keeps the build reproducible: macOS ties that permission to
    # the code hash, so identical sources must yield identical bytes.
    xcrun swiftc native/macos-microphone.swift -O -module-name SeashellMicrophone \
        -framework AVFoundation -framework CoreAudio \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
        -Xlinker native/macos-microphone-Info.plist \
        -o "$BUILD_DIR/seashell-microphone"
    codesign --force --sign - --identifier com.humain.seashell.microphone "$BUILD_DIR/seashell-microphone" 2>/dev/null
    mv -f "$BUILD_DIR/seashell-microphone" "$MICROPHONE_BINARY"
fi
