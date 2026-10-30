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
CALENDAR_BINARY=native/bin/seashell-calendar
if [ ! -x "$CALENDAR_BINARY" ] || \
   [ native/macos-calendar.swift -nt "$CALENDAR_BINARY" ] || \
   [ native/macos-calendar-Info.plist -nt "$CALENDAR_BINARY" ]; then
    # Same pattern as the microphone helper: its own Calendars permission.
    xcrun swiftc native/macos-calendar.swift -O -module-name SeashellCalendar \
        -framework EventKit \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
        -Xlinker native/macos-calendar-Info.plist \
        -o "$BUILD_DIR/seashell-calendar"
    codesign --force --sign - --identifier com.humain.seashell.calendar "$BUILD_DIR/seashell-calendar" 2>/dev/null
    mv -f "$BUILD_DIR/seashell-calendar" "$CALENDAR_BINARY"
fi
SPEAKERS_BINARY=native/bin/seashell-speakers
if [ ! -x "$SPEAKERS_BINARY" ] || \
   [ native/speakers/Package.swift -nt "$SPEAKERS_BINARY" ] || \
   [ native/speakers/Sources/SeashellSpeakers/main.swift -nt "$SPEAKERS_BINARY" ]; then
    # Speaker separation on the Neural Engine (FluidAudio, pinned). A checkout
    # fetches the release; Homebrew stages its source and sets
    # SEASHELL_FLUIDAUDIO_PATH, so the build never needs the network. Optional:
    # without it Sea Shell uses the Python engine, or none.
    SPEAKERS_PACKAGE=native/speakers
    if [ -n "${SEASHELL_FLUIDAUDIO_PATH:-}" ]; then
        # Offline build from staged source. Leave out the remote pin, and the
        # text-normalization binary target: SwiftPM downloads a declared binary
        # target (87 MB) even when the trait that uses it is off.
        SPEAKERS_PACKAGE="$BUILD_DIR/speakers-package"
        mkdir -p "$SPEAKERS_PACKAGE"
        cp -R native/speakers/Package.swift native/speakers/Sources "$SPEAKERS_PACKAGE/"
        for manifest in "$SEASHELL_FLUIDAUDIO_PATH"/Package*.swift; do
            perl -0pi -e 's/\.(?:binaryTarget|target|trait)\(\s*name:\s*"NemoTextProcessing"(?:[^()]++|(\((?:[^()]++|(?1))*+\)))*+\),?//g; s/(\.default\(enabledTraits: \[)"NemoTextProcessing",\s*/$1/g' "$manifest"
        done
    fi
    if swift build -c release --disable-sandbox --package-path "$SPEAKERS_PACKAGE" \
        --scratch-path native/.build-speakers >"$BUILD_DIR/speakers.log" 2>&1; then
        cp native/.build-speakers/release/SeashellSpeakers "$BUILD_DIR/seashell-speakers"
        codesign --force --sign - --identifier com.humain.seashell.speakers "$BUILD_DIR/seashell-speakers" 2>/dev/null
        mv -f "$BUILD_DIR/seashell-speakers" "$SPEAKERS_BINARY"
    else
        echo "Native speaker separation was not built (Swift 6.2+ and FluidAudio are needed):" >&2
        tail -5 "$BUILD_DIR/speakers.log" >&2
    fi
fi
