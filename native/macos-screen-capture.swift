// Seashell's screen recorder. While a meeting records, it records the call's
// window (whatever is shared in the call shows there), or a whole display only
// when asked for one by number. It never falls back to the display: with no
// call window it exits, and Seashell looks again later. A browser's window is
// filmed only while its title, which is its active tab's, looks like a call;
// when the tab changes, filming pauses until a call shows again.
// ScreenCaptureKit captures; AVAssetWriter encodes H.264 or HEVC in hardware,
// at a low frame rate suited to slides and screen shares.
//
// Why native and separate: Screen Recording is a macOS permission, like the
// microphone. As seashell-microphone does, this helper relaunches itself as its
// own responsible process, so macOS asks once for, and remembers, this
// executable's permission rather than whichever terminal or Bun started it.
//
// The movie is written in fragments every few seconds, so a crash or a forced
// stop keeps everything up to the last fragment playable. A sidecar JSON holds
// the first frame's time on the meeting's session clock, so the video and the
// transcript line up.
//
// Events go to stderr as JSON lines; the exit status is 0 when a video was
// saved, 3 when no frame arrived, 4 when no call window was open to film, 77
// without Screen Recording access.

import AVFoundation
import CoreGraphics
import CoreMedia
import CoreText
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit
import VideoToolbox

private let disclaimedEnvironment = "SEASHELL_SCREEN_CAPTURE_RESPONSIBLE"
private let permissionExitCode: Int32 = 77
private let noFramesExitCode: Int32 = 3
private let noWindowExitCode: Int32 = 4
private let usage = """
Usage: seashell-screen-capture --output FILE.mp4 [--sidecar FILE.json] [--session-origin-unix-ms MS]
         [--fps 1-30] [--quality low|medium|high] [--codec hevc|h264] [--seconds N]
         [--pid PID] [--bundle-id ID]... [--app-name NAME] [--call-window-only]
         [--browser-bundle-id ID]... [--call-title TITLE] | --display N
       seashell-screen-capture --status | --request-permission
       seashell-screen-capture --encode-check SECONDS --output FILE.mp4 [--fps N] [--quality Q] [--codec C]
"""

private func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
    FileHandle.standardError.write(data + Data([10]))
}

private func fail(_ message: String, code: Int32 = 1, kind: String = "failed") -> Never {
    emit(["type": "error", "code": kind, "message": message])
    exit(code)
}

// MARK: - Arguments

private let arguments = Array(CommandLine.arguments.dropFirst())
private let flags: Set<String> = ["--status", "--request-permission", "--no-disclaim", "--call-window-only"]
private let valued: Set<String> = ["--output", "--sidecar", "--session-origin-unix-ms", "--fps", "--quality", "--codec",
                                   "--seconds", "--pid", "--bundle-id", "--app-name", "--display", "--encode-check",
                                   "--browser-bundle-id", "--call-title"]
private var given: [String: [String]] = [:]
do {
    var index = 0
    while index < arguments.count {
        let name = arguments[index]
        if flags.contains(name) { given[name, default: []].append(""); index += 1 }
        else if valued.contains(name), index + 1 < arguments.count { given[name, default: []].append(arguments[index + 1]); index += 2 }
        else { FileHandle.standardError.write(Data((usage + "\n").utf8)); exit(2) }
    }
}
private func value(_ name: String) -> String? { given[name]?.last }
private func has(_ name: String) -> Bool { given[name] != nil }

private struct Quality { let longEdge: Int; let bitsPerSecond: Int }
// Bitrates are targets for 2 fps. A still slide costs almost nothing, so most
// of an hour sits well under them; see the README for measured sizes.
private let qualities: [String: Quality] = [
    "low": Quality(longEdge: 1280, bitsPerSecond: 150_000),
    "medium": Quality(longEdge: 1920, bitsPerSecond: 300_000),
    "high": Quality(longEdge: 2560, bitsPerSecond: 800_000),
]
private let fps = Int(value("--fps") ?? "2") ?? 0
private let qualityName = value("--quality") ?? "medium"
private let codecName = value("--codec") ?? "h264"
private let durationSeconds = value("--seconds").flatMap(Double.init)
guard (1...30).contains(fps), let quality = qualities[qualityName], ["hevc", "h264"].contains(codecName),
      durationSeconds == nil || durationSeconds! > 0 else {
    FileHandle.standardError.write(Data((usage + "\n").utf8)); exit(2)
}
/// More frames need more bits, but far fewer than proportionally: frames of a
/// screen differ little from one another.
private let bitsPerSecond = Int(Double(quality.bitsPerSecond) * (Double(max(fps, 1)) / 2).squareRoot())

// MARK: - Responsibility

private typealias DisclaimFunction = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

private func executablePath() -> String? {
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size) + 1)
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path
}

/// Relaunch as a process responsible for itself, proxying termination signals
/// and the exit status. Returns only when that is unavailable.
private func relaunchResponsibleForItself() {
    guard getenv(disclaimedEnvironment) == nil, !has("--no-disclaim"), !has("--encode-check"),
          // RTLD_DEFAULT; the symbol is private but stable since macOS 10.14.
          let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
          let path = executablePath() else { return }
    let disclaim = unsafeBitCast(symbol, to: DisclaimFunction.self)
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return }
    defer { posix_spawnattr_destroy(&attributes) }
    guard disclaim(&attributes, 1) == 0 else { return }
    setenv(disclaimedEnvironment, "1", 1)
    let argv: [UnsafeMutablePointer<CChar>?] = ([path] + arguments).map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var child: pid_t = 0
    let status = posix_spawn(&child, path, nil, &attributes, argv, environ)
    unsetenv(disclaimedEnvironment)
    guard status == 0 else { return }
    var sources: [DispatchSourceSignal] = []
    for value in [SIGINT, SIGTERM, SIGHUP] {
        signal(value, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: value, queue: .global())
        source.setEventHandler { kill(child, value) }
        source.resume()
        sources.append(source)
    }
    var result: Int32 = 0
    while waitpid(child, &result, 0) == -1 && errno == EINTR {}
    sources.forEach { $0.cancel() }
    let terminatingSignal = result & 0x7f
    exit(terminatingSignal == 0 ? (result >> 8) & 0xff : 128 + terminatingSignal)
}

relaunchResponsibleForItself()

// MARK: - Permission

private func printStatus(_ granted: Bool) {
    // macOS only answers yes or no: never asked and turned off look the same.
    let report: [String: Any] = [
        "authorization": granted ? "authorized" : "denied",
        "responsibleForItself": getenv(disclaimedEnvironment) != nil,
        "executable": executablePath() ?? CommandLine.arguments[0],
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .withoutEscapingSlashes]) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

if has("--status") {
    printStatus(CGPreflightScreenCaptureAccess())
    exit(0)
}
if has("--request-permission") {
    // Adds this helper to Privacy & Security → Screen & System Audio Recording
    // and shows macOS's prompt the first time. The switch itself is flipped there.
    let granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    printStatus(granted)
    exit(granted ? 0 : permissionExitCode)
}

// MARK: - Encoding

private func evenPixels(_ value: Double) -> Int { max(2, Int(value.rounded(.down)) & ~1) }

/// Fit the source's pixel size inside the quality's long edge; never enlarge.
private func outputSize(width: Double, height: Double) -> (Int, Int) {
    let scale = min(1, Double(quality.longEdge) / max(width, height, 1))
    return (evenPixels(width * scale), evenPixels(height * scale))
}

private func unixMilliseconds(forHostTime time: CMTime) -> Int64 {
    let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), time))
    return Int64(((Date().timeIntervalSince1970 - age) * 1_000).rounded())
}

private struct Encoder {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let codec: String
    let hardware: Bool
}

/// Hardware HEVC first, then hardware H.264, then whatever encoder exists.
/// Fragments every few seconds keep a crashed recording playable.
private func makeEncoder(url: URL, width: Int, height: Int, realTime: Bool,
                         beforeStart: (AVAssetWriterInput) -> Void = { _ in }) throws -> Encoder {
    let attempts: [(AVVideoCodecType, String, Bool)] = (codecName == "hevc" ? [(.hevc, "hevc", true)] : []) +
        [(.h264, "h264", true), (.h264, "h264", false)]
    var lastError: Error?
    for (codec, name, hardware) in attempts {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.movieFragmentInterval = CMTime(seconds: 4, preferredTimescale: 600)
        writer.shouldOptimizeForNetworkUse = false
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitsPerSecond,
            AVVideoExpectedSourceFrameRateKey: fps,
            // A key frame at least every 10 seconds keeps seeking quick.
            AVVideoMaxKeyFrameIntervalDurationKey: 10,
            AVVideoAllowFrameReorderingKey: false,
        ]
        if codec == .h264 { compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
        var settings: [String: Any] = [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compression,
        ]
        if hardware {
            settings[AVVideoEncoderSpecificationKey] = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true]
        }
        guard writer.canApply(outputSettings: settings, forMediaType: .video) else { continue }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = realTime
        guard writer.canAdd(input) else { continue }
        writer.add(input)
        beforeStart(input)
        if writer.startWriting() { return Encoder(writer: writer, input: input, codec: name, hardware: hardware) }
        lastError = writer.error
    }
    try? FileManager.default.removeItem(at: url)
    throw lastError ?? NSError(domain: "SeashellScreenCapture", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "No video encoder accepted \(width)×\(height) at \(fps) fps.",
    ])
}

private func fileSize(_ path: String) -> Int {
    ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue ?? 0
}

// MARK: - Encoder check

/// Encodes a synthetic screen share (slides that change every 30 s, a moving
/// pointer and a talking-head tile) as fast as possible and reports its size.
/// Nothing on screen is recorded, so it needs no permission.
private func runEncodeCheck(seconds: Double, output: String) -> Never {
    let (width, height) = outputSize(width: Double(quality.longEdge), height: Double(quality.longEdge) * 10 / 16)
    let url = URL(fileURLWithPath: output)
    let encoder: Encoder
    var adaptor: AVAssetWriterInputPixelBufferAdaptor!
    do {
        encoder = try makeEncoder(url: url, width: width, height: height, realTime: false) { input in
            adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ])
        }
    } catch { fail(error.localizedDescription) }
    encoder.writer.startSession(atSourceTime: .zero)
    let total = Int(seconds * Double(fps))
    let words = ["roadmap", "pipeline", "customers", "revenue", "launch", "hiring", "latency", "budget", "design", "metrics",
                 "onboarding", "retention", "pricing", "support", "quarter", "goals", "risks", "owners", "timeline", "review"]
    let font = CTFontCreateWithName("Helvetica" as CFString, CGFloat(height) / 28, nil)
    let titleFont = CTFontCreateWithName("Helvetica-Bold" as CFString, CGFloat(height) / 16, nil)
    func draw(_ text: String, _ font: CTFont, _ x: CGFloat, _ y: CGFloat, in context: CGContext) {
        let attributes = [NSAttributedString.Key(kCTFontAttributeName as String): font,
                          NSAttributedString.Key(kCTForegroundColorFromContextAttributeName as String): true] as [NSAttributedString.Key: Any]
        context.textPosition = CGPoint(x: x, y: y)
        CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes)), context)
    }
    var frame = 0
    let finished = DispatchSemaphore(value: 0)
    encoder.input.requestMediaDataWhenReady(on: DispatchQueue(label: "encode-check")) {
        while encoder.input.isReadyForMoreMediaData {
            guard frame < total, let pool = adaptor.pixelBufferPool else {
                encoder.input.markAsFinished()
                encoder.writer.endSession(atSourceTime: CMTime(seconds: seconds, preferredTimescale: 600))
                encoder.writer.finishWriting { finished.signal() }
                return
            }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            let t = Double(frame) / Double(fps)
            let slide = Int(t / 30)
            if let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
                                       bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
                                       bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) {
                let w = CGFloat(width), h = CGFloat(height)
                context.setFillColor(red: 0.97, green: 0.97, blue: 0.95, alpha: 1)
                context.fill(CGRect(x: 0, y: 0, width: w, height: h))
                context.setFillColor(red: 0.1, green: 0.12, blue: 0.2, alpha: 1)
                draw("Slide \(slide + 1): \(words[slide % words.count]) and \(words[(slide * 7 + 3) % words.count])", titleFont, w * 0.06, h * 0.86, in: context)
                for line in 0..<7 {
                    let text = (0..<6).map { words[(slide * 13 + line * 5 + $0 * 3) % words.count] }.joined(separator: " ")
                    draw("•  \(text)", font, w * 0.08, h * (0.74 - CGFloat(line) * 0.07), in: context)
                }
                for bar in 0..<6 {
                    let value = CGFloat((slide * 31 + bar * 17) % 10 + 2) / 12
                    context.setFillColor(red: 0.2, green: 0.45, blue: 0.85, alpha: 1)
                    context.fill(CGRect(x: w * (0.62 + CGFloat(bar) * 0.05), y: h * 0.12, width: w * 0.035, height: h * 0.3 * value))
                }
                // A talking-head tile: smooth motion every frame.
                let tile = CGRect(x: w * 0.76, y: h * 0.62, width: w * 0.2, height: w * 0.1125)
                context.setFillColor(red: 0.18, green: 0.2, blue: 0.24, alpha: 1)
                context.fill(tile)
                context.setFillColor(red: 0.85, green: 0.7 + 0.1 * sin(t), blue: 0.6, alpha: 1)
                context.fillEllipse(in: CGRect(x: tile.midX - tile.height * 0.22 + tile.width * 0.08 * sin(t * 1.3),
                                               y: tile.minY + tile.height * 0.35 + tile.height * 0.05 * cos(t * 2.1),
                                               width: tile.height * 0.44, height: tile.height * 0.5))
                // The pointer wanders.
                context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
                context.fill(CGRect(x: w * (0.3 + 0.2 * sin(t / 7)), y: h * (0.4 + 0.2 * cos(t / 5)), width: 10, height: 16))
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps)))
            frame += 1
        }
    }
    finished.wait()
    guard encoder.writer.status == .completed else { fail(encoder.writer.error?.localizedDescription ?? "Encoding failed") }
    let bytes = fileSize(output)
    let report: [String: Any] = [
        "seconds": seconds, "fps": fps, "quality": qualityName, "codec": encoder.codec, "hardware": encoder.hardware,
        "width": width, "height": height, "bitsPerSecond": bitsPerSecond, "bytes": bytes,
        "megabytesPerHour": Int((Double(bytes) / 1_000_000 * 3_600 / seconds).rounded()),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
    exit(0)
}

if let seconds = value("--encode-check").flatMap(Double.init) {
    guard seconds > 0, let output = value("--output") else { FileHandle.standardError.write(Data((usage + "\n").utf8)); exit(2) }
    runEncodeCheck(seconds: seconds, output: output)
}

// MARK: - Target

private let outputPath = value("--output") ?? ""
if outputPath.isEmpty { FileHandle.standardError.write(Data((usage + "\n").utf8)); exit(2) }
private let sidecarPath = value("--sidecar")
private let sessionOriginUnixMs = value("--session-origin-unix-ms").flatMap(Int64.init)
private let wantedPid = value("--pid").flatMap(Int32.init) ?? 0
private let wantedBundles = (given["--bundle-id"] ?? []).map { $0.lowercased() }
private let wantedAppName = value("--app-name")?.lowercased()
private let wantedDisplay = value("--display").flatMap(Int.init)
private let callWindowOnly = has("--call-window-only")
private let browserBundles = (given["--browser-bundle-id"] ?? []).map { $0.lowercased() }
private let eventTitle = value("--call-title")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
private let wantsWindow = wantedDisplay == nil && (wantedPid > 0 || !wantedBundles.isEmpty || wantedAppName != nil)
// The whole display is filmed only when asked for by number.
if !wantsWindow && wantedDisplay == nil {
    FileHandle.standardError.write(Data((usage + "\n").utf8)); exit(2)
}

/// Browsers and some call apps run helpers under the app's bundle ID plus a
/// suffix (com.google.Chrome.helper), so compare application families.
private func sameFamily(_ left: String, _ right: String) -> Bool {
    left == right || left.hasPrefix(right + ".") || right.hasPrefix(left + ".")
}

private let callTitle = try! NSRegularExpression(
    pattern: #"\b(meet|zoom|teams|webex|facetime|huddle|call|meeting|whereby|around)\b|meet\.google\.com"#,
    options: [.caseInsensitive])
private func looksLikeCall(_ title: String) -> Bool {
    callTitle.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil
}

/// A browser window's title is its active tab's. These are the tabs of a call:
/// the service's name where it puts it, or the calendar event's own title.
private let browserCallServices: [(name: String, pattern: NSRegularExpression)] = [
    ("Google Meet", #"(?i:google meet|meet\.google\.com)|^Meet\b"#),
    ("Zoom", #"^Zoom\b|(?:[-|–—:] )Zoom\b"#),
    ("Microsoft Teams", #"(?i:microsoft teams)"#),
    ("Webex", #"(?i:\bwebex\b)"#),
    ("Whereby", #"(?i:\bwhereby\b)"#),
    ("Around", #"^Around\b|(?:[-|–—:] )Around\b"#),
].map { ($0.0, try! NSRegularExpression(pattern: $0.1)) }

private func browserCallService(_ title: String) -> String? {
    let range = NSRange(title.startIndex..., in: title)
    if let service = browserCallServices.first(where: { $0.pattern.firstMatch(in: title, range: range) != nil }) { return service.name }
    return eventTitle.count >= 3 && title.localizedCaseInsensitiveContains(eventTitle) ? "the call" : nil
}

private func isBrowser(_ bundle: String) -> Bool {
    browserBundles.contains { sameFamily(bundle.lowercased(), $0) }
}

/// Whether a window may be filmed now: a browser's only while its tab is a call.
private func filmable(title: String, bundle: String) -> Bool {
    isBrowser(bundle) ? browserCallService(title) != nil : !callWindowOnly || looksLikeCall(title)
}

private struct Target {
    let filter: SCContentFilter
    let width: Double
    let height: Double
    let description: [String: Any]
    /// A browser window, whose tab is checked before every frame.
    var browserWindow: CGWindowID? = nil
}

private func pointPixelScale(_ filter: SCContentFilter) -> Double {
    if #available(macOS 14.0, *) { return Double(filter.pointPixelScale) }
    return 2
}

/// The meeting app's main window: a normal window big enough to hold a call,
/// preferring titles that look like one, then the largest.
private func callWindow(in content: SCShareableContent) -> SCWindow? {
    let matching = content.windows.filter { window in
        guard window.windowLayer == 0, window.frame.width >= 320, window.frame.height >= 240,
              let app = window.owningApplication else { return false }
        let bundle = app.bundleIdentifier.lowercased()
        let byApp = (wantedPid > 0 && app.processID == wantedPid) ||
            wantedBundles.contains { sameFamily(bundle, $0) } ||
            (wantedAppName.map { app.applicationName.lowercased() == $0 || bundle == $0 } ?? false)
        return byApp && filmable(title: window.title ?? "", bundle: bundle)
    }
    func rank(_ window: SCWindow) -> (Int, Double) {
        let title = window.title ?? ""
        let score = (looksLikeCall(title) ? 4 : 0) + (title.isEmpty ? 0 : 2) + (window.isOnScreen ? 1 : 0)
        return (score, Double(window.frame.width * window.frame.height))
    }
    return matching.max { rank($0) < rank($1) }
}

/// Displays in order: the main display is 1.
private func orderedDisplays(_ content: SCShareableContent) -> [SCDisplay] {
    let main = CGMainDisplayID()
    return content.displays.sorted { ($0.displayID == main ? 0 : 1, $0.frame.minX) < ($1.displayID == main ? 0 : 1, $1.frame.minX) }
}

private func windowTarget(_ window: SCWindow) -> Target {
    // Independent of its desktop: it records on another Space or under other windows.
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let scale = pointPixelScale(filter)
    let bundle = window.owningApplication?.bundleIdentifier ?? ""
    var description: [String: Any] = ["kind": "window", "title": window.title ?? "",
                                      "app": window.owningApplication?.applicationName ?? "", "bundleId": bundle]
    // What the call is, by its service's name: never the tab's title.
    let browser = isBrowser(bundle)
    if browser, let service = browserCallService(window.title ?? "") { description["call"] = service }
    return Target(filter: filter, width: window.frame.width * scale, height: window.frame.height * scale,
                  description: description, browserWindow: browser ? window.windowID : nil)
}

/// The title a window has now, read without waiting: a browser's changes with its tab.
private func currentTitle(_ window: CGWindowID) -> String? {
    guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], window) as? [[String: Any]],
          let entry = info.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window }) else { return nil }
    return entry[kCGWindowName as String] as? String ?? ""
}

/// The call's window, or the display asked for by number. Never a display in place of a window.
private func resolveTarget(_ content: SCShareableContent) -> Target? {
    if wantsWindow { return callWindow(in: content).map(windowTarget) }
    let displays = orderedDisplays(content)
    let index = (wantedDisplay ?? 1) - 1
    guard displays.indices.contains(index) else { return nil }
    let display = displays[index]
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let scale = pointPixelScale(filter)
    return Target(filter: filter, width: Double(display.width) * scale, height: Double(display.height) * scale,
                  description: ["kind": "display", "display": index + 1])
}

private func shareableContent(_ completion: @escaping (SCShareableContent?, Error?) -> Void) {
    // Windows on other desktops are off screen; include them.
    SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false, completionHandler: completion)
}

// MARK: - Recording

private final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let queue = DispatchQueue(label: "com.humain.seashell.screen-capture.frames")
    private let encoder: Encoder
    private let configuration: SCStreamConfiguration
    private var target: Target
    private var stream: SCStream?
    private var firstFrame: CMTime?
    private var firstFrameUnixMs: Int64?
    private var lastFrame: CMTime?
    private var frames = 0
    private var stopping = false

    init(target: Target, encoder: Encoder, width: Int, height: Int) {
        self.target = target
        self.encoder = encoder
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.showsCursor = true
        configuration.queueDepth = 5
        // A resized window is scaled into the same frame, letterboxed.
        configuration.scalesToFit = true
        if #available(macOS 14.0, *) {
            configuration.preservesAspectRatio = true
            configuration.ignoreShadowsSingleWindow = true
        }
        self.configuration = configuration
    }

    func start() {
        let stream = SCStream(filter: target.filter, configuration: configuration, delegate: self)
        do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue) }
        catch { fail("Could not receive screen frames: \(error.localizedDescription)") }
        self.stream = stream
        stream.startCapture { [weak self] error in
            guard let error else { return }
            self?.queue.async { self?.lost("Screen capture did not start: \(error.localizedDescription)") }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        // Frames still queued from a stream paused for another tab are dropped with it.
        guard type == .screen, !stopping, stream === self.stream, sampleBuffer.isValid,
              let attachments = (CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
              let raw = attachments[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
        // A browser's tab is checked before each frame: another tab is never written, even once.
        if let window = target.browserWindow, !(currentTitle(window).map { browserCallService($0) != nil } ?? false) {
            pause("The browser is showing another tab, so the video is paused until the call shows again.")
            return
        }
        let time = sampleBuffer.presentationTimeStamp
        if firstFrame == nil {
            encoder.writer.startSession(atSourceTime: time)
            firstFrame = time
            firstFrameUnixMs = unixMilliseconds(forHostTime: time)
            writeSidecar(finished: false)
            var event: [String: Any] = ["type": "first-frame", "firstFrameUnixMs": firstFrameUnixMs!]
            if let origin = sessionOriginUnixMs { event["firstFrameSessionMs"] = firstFrameUnixMs! - origin }
            emit(event)
        }
        // Drop rather than queue: a screen's next frame replaces this one.
        guard encoder.input.isReadyForMoreMediaData else { return }
        if encoder.input.append(sampleBuffer) {
            frames += 1
            lastFrame = time
        } else {
            emit(["type": "warning", "message": "The video encoder stopped: \(encoder.writer.error?.localizedDescription ?? "unknown error")"])
            finish()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.lost("Screen capture stopped: \(error.localizedDescription)") }
    }

    /// The window closed or the display went away. Keep the file and look for
    /// the call's window again; never switch to recording something else.
    private func lost(_ message: String) {
        guard !stopping else { return }
        stream = nil
        emit(["type": "warning", "message": message])
        emit(["type": "waiting", "message": message])
        queue.asyncAfter(deadline: .now() + 3) { self.reacquire() }
    }

    /// Stop filming what is on screen now, and keep the movie for when the call shows again.
    private func pause(_ message: String) {
        guard !stopping, let stream else { return }
        self.stream = nil
        stream.stopCapture { _ in }
        emit(["type": "waiting", "message": message])
        queue.asyncAfter(deadline: .now() + 3) { self.reacquire() }
    }

    private func reacquire() {
        guard !stopping, stream == nil else { return }
        shareableContent { content, _ in
            self.queue.async {
                guard !self.stopping, self.stream == nil else { return }
                let window = content.flatMap { wantsWindow ? callWindow(in: $0) : nil }
                if let window { self.target = windowTarget(window) }
                else if let content, !wantsWindow, let display = resolveTarget(content) { self.target = display }
                else { self.queue.asyncAfter(deadline: .now() + 3) { self.reacquire() }; return }
                emit((["type": "target"] as [String: Any]).merging(self.target.description) { $1 })
                self.start()
            }
        }
    }

    func stop() {
        queue.async {
            guard !self.stopping else { return }
            self.stopping = true
            guard let stream = self.stream else { return self.finish() }
            // stopCapture can stall when the stream is already failing.
            var done = false
            let complete = { self.queue.async { if !done { done = true; self.finish() } } }
            stream.stopCapture { _ in complete() }
            self.queue.asyncAfter(deadline: .now() + 2, execute: complete)
        }
    }

    private func finish() {
        stopping = true
        guard let firstFrame else {
            encoder.writer.cancelWriting()
            try? FileManager.default.removeItem(atPath: outputPath)
            if let sidecarPath { try? FileManager.default.removeItem(atPath: sidecarPath) }
            fail("No screen frames arrived, so no video was saved.", code: noFramesExitCode, kind: "no-frames")
        }
        encoder.input.markAsFinished()
        // Hold the last frame until the stop, so a still screen keeps its length.
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let end = CMTimeMaximum(CMTimeMaximum(lastFrame ?? firstFrame, now), firstFrame)
        encoder.writer.endSession(atSourceTime: end)
        encoder.writer.finishWriting {
            let saved = self.encoder.writer.status == .completed
            self.writeSidecar(finished: saved, end: end)
            emit(["type": "stopped", "frames": self.frames, "bytes": fileSize(outputPath), "saved": saved])
            exit(saved ? 0 : 1)
        }
    }

    private func writeSidecar(finished: Bool, end: CMTime? = nil) {
        guard let sidecarPath, let firstFrame, let firstFrameUnixMs else { return }
        var sidecar: [String: Any] = [
            "schemaVersion": 1,
            "file": URL(fileURLWithPath: outputPath).lastPathComponent,
            "codec": encoder.codec,
            "fps": fps,
            "quality": qualityName,
            "width": configuration.width,
            "height": configuration.height,
            "bitsPerSecond": bitsPerSecond,
            "target": target.description,
            "firstFrameUnixMs": firstFrameUnixMs,
            "frames": frames,
            "finished": finished,
        ]
        if let origin = sessionOriginUnixMs {
            sidecar["sessionOriginUnixMs"] = origin
            sidecar["firstFrameSessionMs"] = firstFrameUnixMs - origin
        }
        if let end { sidecar["durationMs"] = Int64((CMTimeGetSeconds(CMTimeSubtract(end, firstFrame)) * 1_000).rounded()) }
        guard let data = try? JSONSerialization.data(withJSONObject: sidecar, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return }
        let temporary = sidecarPath + ".partial"
        if FileManager.default.createFile(atPath: temporary, contents: data + Data([10]), attributes: [.posixPermissions: 0o600]) {
            _ = rename(temporary, sidecarPath)
        }
    }
}

// Never prompt from a recording: the person may be mid-call. Setup asks.
guard CGPreflightScreenCaptureAccess() else {
    fail("Screen Recording is off for Seashell Screen Capture. Run: seashell meeting video setup", code: permissionExitCode, kind: "permission")
}

signal(SIGPIPE, SIG_IGN)
private var recorder: Recorder?
private var stopRequested = false
private func requestStop() {
    if stopRequested { return }
    stopRequested = true
    if let recorder { recorder.stop() } else { exit(0) }
}
private var signalSources: [DispatchSourceSignal] = []
for value in [SIGINT, SIGTERM, SIGHUP] {
    signal(value, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
    source.setEventHandler { requestStop() }
    source.resume()
    signalSources.append(source)
}
// A proxy killed with SIGKILL cannot forward a stop. Finish the file and go.
private let launchParent = getppid()
private let parentWatch = DispatchSource.makeTimerSource(queue: .main)
parentWatch.schedule(deadline: .now() + 0.5, repeating: 0.5)
parentWatch.setEventHandler { if getppid() != launchParent { requestStop() } }
parentWatch.resume()
if let durationSeconds {
    DispatchQueue.main.asyncAfter(deadline: .now() + durationSeconds) { requestStop() }
}

shareableContent { content, error in
    DispatchQueue.main.async {
        guard let content else {
            fail("Could not list windows and displays: \(error?.localizedDescription ?? "unknown error")",
                 code: CGPreflightScreenCaptureAccess() ? 1 : permissionExitCode,
                 kind: CGPreflightScreenCaptureAccess() ? "failed" : "permission")
        }
        guard let target = resolveTarget(content) else {
            if wantsWindow { fail("No call window is open to film.", code: noWindowExitCode, kind: "no-window") }
            fail("That display is not connected.", kind: "no-target")
        }
        let (width, height) = outputSize(width: target.width, height: target.height)
        let encoder: Encoder
        do { encoder = try makeEncoder(url: URL(fileURLWithPath: outputPath), width: width, height: height, realTime: true) }
        catch { fail("Could not start the video encoder: \(error.localizedDescription)") }
        emit((["type": "target", "width": width, "height": height, "codec": encoder.codec, "hardware": encoder.hardware] as [String: Any])
            .merging(target.description) { $1 })
        let started = Recorder(target: target, encoder: encoder, width: width, height: height)
        recorder = started
        if stopRequested { started.stop() } else { started.start() }
    }
}
dispatchMain()
