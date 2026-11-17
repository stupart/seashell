// Seashell's microphone recorder. Writes mono signed 16-bit little-endian PCM
// to stdout: the same contract as `sox -d -t raw -r 16000 -c 1 -b 16 -e signed-integer -`.
//
// Why native: the background watcher runs inside a developer-signed Bun that
// uses the hardened runtime without the audio-input entitlement. macOS gives
// any recorder it spawns silent buffers and never asks for permission. This
// helper relaunches itself as its own responsible process, so macOS evaluates,
// and asks once for, this executable's Microphone permission instead.
//
// It also follows input-device changes (AirPods, docks, default-input changes)
// by rebuilding its engine, and pads the stream with silence across any gap so
// the sample count stays on the wall-clock timeline the capture store expects.
// It rebuilds only for a real change or an engine that stopped, never because
// buffers were late: a quiet or busy Mac is not a broken microphone.
//
// The input tap only copies each buffer into a preallocated lock-free ring
// (seashell-audio-ring.c). A consumer queue converts and writes stdout without
// ever waiting for the reader: audio that cannot keep up is replaced by silence
// of the same length. `--mix-check` proves both on synthetic buffers.
//
// Protocol 4 (SeashellHelperProtocol in macos-microphone-Info.plist) adds
// `--device-uid UID`: record that input device (a kAudioDevicePropertyDeviceUID)
// instead of the default, and the default while it is disconnected. Microphone
// access is the app's, not the device's, so it costs no further prompt.
// Protocol 3 helpers reject the flag: check the protocol first.

import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

private let disclaimedEnvironment = "SEASHELL_MICROPHONE_RESPONSIBLE"
private let permissionExitCode: Int32 = 77
private let usage = "Usage: seashell-microphone [--sample-rate HZ] [--seconds N] [--device-uid UID] [--status | --request-permission] [--no-disclaim]"

/** One line on stderr in a single write. A closed stderr is ignored, where FileHandle would raise. */
private func say(_ message: String) {
    let line = Array((message + "\n").utf8)
    line.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        var offset = 0
        while offset < bytes.count {
            let written = Darwin.write(STDERR_FILENO, base + offset, bytes.count - offset)
            if written < 0 && errno == EINTR { continue }
            if written <= 0 { return }
            offset += written
        }
    }
}

private func fail(_ message: String, code: Int32 = 1) -> Never {
    say(message)
    exit(code)
}

private func argument(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

private let arguments = Array(CommandLine.arguments.dropFirst())
private let flags = ["--status", "--request-permission", "--no-disclaim", "--mix-check"]
private let valued = ["--sample-rate", "--seconds", "--device-uid"]
do {
    var index = 0
    while index < arguments.count {
        if flags.contains(arguments[index]) { index += 1 }
        else if valued.contains(arguments[index]), index + 1 < arguments.count { index += 2 }
        else { fail(usage, code: 2) }
    }
}
private let sampleRate = Double(argument("--sample-rate", in: arguments) ?? "16000") ?? 0
private let durationSeconds = argument("--seconds", in: arguments).flatMap(Double.init)
private let deviceUID = argument("--device-uid", in: arguments)
guard [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].contains(sampleRate),
      durationSeconds == nil || durationSeconds! > 0,
      deviceUID.map({ !$0.isEmpty }) ?? true else { fail(usage, code: 2) }

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
    guard getenv(disclaimedEnvironment) == nil, !arguments.contains("--no-disclaim"),
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

// A proxy killed with SIGKILL cannot forward a stop. Never outlive it.
private let launchParent = getppid()
private let parentWatch = DispatchSource.makeTimerSource(queue: .global())
parentWatch.schedule(deadline: .now() + 0.5, repeating: 0.5)
parentWatch.setEventHandler { if getppid() != launchParent { exit(0) } }
parentWatch.resume()

// MARK: - Permission

private func authorizationName(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

private func printStatus(_ status: AVAuthorizationStatus) {
    let report: [String: Any] = [
        "authorization": authorizationName(status),
        "responsibleForItself": getenv(disclaimedEnvironment) != nil,
        "executable": executablePath() ?? CommandLine.arguments[0],
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .withoutEscapingSlashes]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}

private let permissionHelp = "Microphone access is off for Seashell Microphone. Allow it in System Settings → Privacy & Security → Microphone, or run: seashell meeting microphone setup"

/// Mono at the capture rate, from any PCM input: 16- or 32-bit integer or
/// float, interleaved or not, any channel count or layout, any sample rate.
///
/// AVAudioConverter's downmix needs a spatial channel layout. A built-in
/// microphone array reports a discrete one, for which it silently outputs
/// zeros. So nothing here asks it to mix: the input is unpacked to Float32,
/// one buffer per channel, keeping its channels and layout; the channels are
/// averaged here; and only that mono signal is resampled.
final class MonoConverter {
    let input: AVAudioFormat
    private let planar: AVAudioFormat
    /// Nil when the input is already Float32 with one buffer per channel.
    private let unpacker: AVAudioConverter?
    private let mono: AVAudioFormat
    private let resampler: AVAudioConverter
    private let target: AVAudioFormat

    init?(from input: AVAudioFormat, to target: AVAudioFormat) {
        let channels = input.channelCount
        guard channels > 0, input.sampleRate > 0 else { return nil }
        // Formats with more than two channels need a layout; a discrete one
        // keeps every channel where it is.
        let layout = input.channelLayout
            ?? (channels > 2 ? AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | channels) : nil)
        let planar = layout.map { AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: input.sampleRate, interleaved: false, channelLayout: $0) }
            ?? AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: input.sampleRate, channels: channels, interleaved: false)
        guard let planar,
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: input.sampleRate, channels: 1, interleaved: false),
              let resampler = AVAudioConverter(from: mono, to: target) else { return nil }
        // The default quality loses about 2 dB of speech when decimating 192 kHz.
        resampler.sampleRateConverterQuality = AVAudioQuality.max.rawValue
        let unpacked = input.commonFormat == .pcmFormatFloat32 && !input.isInterleaved
        let unpacker = unpacked ? nil : AVAudioConverter(from: input, to: planar)
        guard unpacked || unpacker != nil else { return nil }
        self.input = input
        self.planar = planar
        self.unpacker = unpacker
        self.mono = mono
        self.resampler = resampler
        self.target = target
    }

    private func mixed(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        var source = buffer
        if let unpacker {
            guard let unpacked = AVAudioPCMBuffer(pcmFormat: planar, frameCapacity: buffer.frameLength),
                  (try? unpacker.convert(to: unpacked, from: buffer)) != nil else { return nil }
            source = unpacked
        }
        guard let channels = source.floatChannelData,
              let output = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: source.frameLength),
              let destination = output.floatChannelData?[0] else { return nil }
        let frames = Int(source.frameLength)
        output.frameLength = source.frameLength
        // Average only channels that carry something. The spare channels of an
        // aggregate device or audio interface are digital silence, and counting
        // them would make you quieter.
        let live = (0..<Int(source.format.channelCount)).filter { channel in
            (0..<frames).contains { channels[channel][$0] != 0 }
        }
        for frame in 0..<frames {
            var sum: Float = 0
            for channel in live { sum += channels[channel][frame] }
            destination[frame] = live.isEmpty ? 0 : sum / Float(live.count)
        }
        return output
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard buffer.frameLength > 0, let input = mixed(buffer) else { return nil }
        // Room for twice the expected output: the resampler works in blocks of
        // up to 4,096 frames and catches up on what it held back last time.
        let capacity = AVAudioFrameCount((Double(input.frameLength) * target.sampleRate / mono.sampleRate * 2).rounded(.up)) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = resampler.convert(to: converted, error: &error) { _, inputStatus in
            if supplied { inputStatus.pointee = .noDataNow; return nil }
            supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        return status == .error || converted.frameLength == 0 ? nil : converted
    }

    /// What the resampler still holds at the end of this input, which belongs
    /// before anything after it. The resampler starts afresh afterwards.
    func finish() -> AVAudioPCMBuffer? {
        defer { resampler.reset() }
        guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 16_384) else { return nil }
        var error: NSError?
        let status = resampler.convert(to: converted, error: &error) { _, inputStatus in
            inputStatus.pointee = .endOfStream
            return nil
        }
        return status == .error || converted.frameLength == 0 ? nil : converted
    }
}

/// Every input shape the conversion has to survive: sample formats, interleaving,
/// channel layouts from mono to aggregate devices, and Bluetooth to studio rates.
private func mixCheck() -> Bool {
    struct Shape { let name: String; let channels: UInt32; let tag: AudioChannelLayoutTag?; let live: [Int] }
    let shapes = [
        Shape(name: "mono", channels: 1, tag: nil, live: [0]),
        Shape(name: "stereo", channels: 2, tag: kAudioChannelLayoutTag_Stereo, live: [0, 1]),
        Shape(name: "built-in mic, 3 discrete", channels: 3, tag: kAudioChannelLayoutTag_DiscreteInOrder | 3, live: [0, 1, 2]),
        Shape(name: "4 discrete", channels: 4, tag: kAudioChannelLayoutTag_DiscreteInOrder | 4, live: [0, 1, 2, 3]),
        Shape(name: "quadraphonic", channels: 4, tag: kAudioChannelLayoutTag_Quadraphonic, live: [0, 1, 2, 3]),
        Shape(name: "interface, 8 discrete, input 1 only", channels: 8, tag: kAudioChannelLayoutTag_DiscreteInOrder | 8, live: [0]),
        Shape(name: "aggregate, 5 discrete, 2 live", channels: 5, tag: kAudioChannelLayoutTag_DiscreteInOrder | 5, live: [1, 3]),
    ]
    let formats: [(String, AVAudioCommonFormat)] = [("int16", .pcmFormatInt16), ("int32", .pcmFormatInt32), ("float32", .pcmFormatFloat32)]
    let rates: [Double] = [8_000, 16_000, 22_050, 24_000, 44_100, 48_000, 96_000, 192_000]
    guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true) else { return false }
    var cases = 0
    var lowest = Int32.max
    var failures: [[String: Any]] = []
    for shape in shapes { for (formatName, common) in formats { for interleaved in [true, false] { for rate in rates {
        let name = "\(formatName) \(interleaved ? "interleaved" : "planar") · \(shape.name) · \(Int(rate)) Hz"
        let layout = shape.tag.flatMap { AVAudioChannelLayout(layoutTag: $0) }
        let format = layout.map { AVAudioFormat(commonFormat: common, sampleRate: rate, interleaved: interleaved, channelLayout: $0) }
            ?? AVAudioFormat(commonFormat: common, sampleRate: rate, channels: shape.channels, interleaved: interleaved)
        cases += 1
        guard let format, let converter = MonoConverter(from: format, to: target) else {
            failures.append(["case": name, "error": "no converter"]); continue
        }
        // Two seconds of a 440 Hz tone at a quarter of full scale, delivered in
        // tap-sized buffers the way the engine hands them over.
        let total = Int(rate * 2), block = 4_096
        var peak: Int32 = 0, frames = 0, written = 0
        while written < total {
            let count = min(block, total - written)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { break }
            buffer.frameLength = AVAudioFrameCount(count)
            let stride = Int(buffer.stride)
            for frame in 0..<count {
                let value = 0.25 * sin(2 * Double.pi * 440 * Double(written + frame) / rate)
                for channel in 0..<Int(shape.channels) {
                    let sample = shape.live.contains(channel) ? value : 0
                    let (pointer, offset) = interleaved ? (0, frame * stride + channel) : (channel, frame)
                    switch common {
                    case .pcmFormatInt16: buffer.int16ChannelData![pointer][offset] = Int16(sample * 32_767)
                    case .pcmFormatInt32: buffer.int32ChannelData![pointer][offset] = Int32(sample * 2_147_483_647)
                    default: buffer.floatChannelData![pointer][offset] = Float(sample)
                    }
                }
            }
            written += count
            guard let output = converter.convert(buffer), let samples = output.int16ChannelData?[0] else { continue }
            for frame in 0..<Int(output.frameLength) { peak = max(peak, abs(Int32(samples[frame]))) }
            frames += Int(output.frameLength)
        }
        lowest = min(lowest, peak)
        // A quarter of full scale is 8191. The resampler may hold back one block
        // (a quarter second at most), but must not lose or invent audio.
        if peak < 7_000 || frames < 32_000 - 4_160 || frames > 32_000 + 64 {
            failures.append(["case": name, "peak": Int(peak), "frames": frames])
        }
    } } } }
    let handoff = handoffCheck(target: target, failures: &failures)
    let report: [String: Any] = ["cases": cases, "peak": Int(lowest == .max ? 0 : lowest), "handoff": handoff, "failures": failures]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    return failures.isEmpty
}

// Runs the real conversion on tones shaped like every kind of input, and the
// real handoff on synthetic tap buffers. No microphone is opened and nothing
// is recorded.
if arguments.contains("--mix-check") { exit(mixCheck() ? 0 : 1) }

if arguments.contains("--status") {
    printStatus(AVCaptureDevice.authorizationStatus(for: .audio))
    exit(0)
}
if arguments.contains("--request-permission") {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let answered = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in answered.signal() }
        answered.wait()
    }
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    printStatus(status)
    exit(status == .authorized ? 0 : permissionExitCode)
}

// MARK: - Output

signal(SIGPIPE, SIG_IGN)

/** mach_absolute_time() in seconds: the clock the ring stamps each tap buffer with. */
private enum HostClock {
    // Static, so initialized on first use: the self-test runs before this file's later globals are.
    static let ticksPerSecond: Double = {
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        return 1e9 * Double(timebase.denom) / Double(timebase.numer)
    }()
}
private func hostSeconds(_ ticks: UInt64 = mach_absolute_time()) -> Double { Double(ticks) / HostClock.ticksPerSecond }

/// The PCM stream on stdout, kept on the wall-clock timeline. Used on the
/// consumer queue only. It never waits for its reader: audio stdout cannot take
/// is replaced by silence of the same length, so later speech keeps its place.
private final class PcmOutput {
    /** Seconds of audio kept for a reader that is away, as Bun is under load. */
    static let seconds = 30.0
    private let rate: Double
    private let pipe: OpaquePointer
    private let onReaderGone: () -> Void
    private let report: (String) -> Void
    private var readerGone = false
    private var startedAt: Double?
    private var framesWritten: Int64 = 0
    /** Audio stdout could not take, said once that stretch ends. */
    private var replaced: (start: Int64, frames: Int64)?
    private(set) var replacedFrames: Int64 = 0

    init?(rate: Double, output: Int32 = STDOUT_FILENO, seconds: Double = PcmOutput.seconds,
          onReaderGone: @escaping () -> Void = { exit(0) }, report: @escaping (String) -> Void = say) {
        guard let pipe = seashell_pcm_pipe_create(output, Int(rate * seconds) * 2) else { return nil }
        self.rate = rate
        self.pipe = pipe
        self.onReaderGone = onReaderGone
        self.report = report
    }

    deinit { seashell_pcm_pipe_destroy(pipe) }

    /// `capturedAt`: host seconds when the tap handed these samples over, after
    /// `droppedBefore` frames that never reached the consumer.
    func write(_ samples: UnsafePointer<Int16>, frames: Int, capturedAt: Double, droppedBefore: Int = 0) {
        if let startedAt {
            // Device switches and engine rebuilds pause delivery. Fill the gap
            // so later speech keeps its true position in the meeting.
            let behind = Int64(((capturedAt - startedAt) * rate).rounded()) - Int64(frames + droppedBefore) - framesWritten
            if behind > Int64(rate / 2) { writeSilence(Int(behind)) }
        } else {
            startedAt = capturedAt - Double(frames + droppedBefore) / rate
        }
        writeSilence(droppedBefore)
        if seashell_pcm_pipe_append(pipe, samples, frames * 2) == 0 {
            closeReplaced()
        } else if let stretch = replaced, stretch.start + stretch.frames == framesWritten {
            replaced = (stretch.start, stretch.frames + Int64(frames))
        } else {
            closeReplaced()
            replaced = (framesWritten, Int64(frames))
        }
        framesWritten += Int64(frames)
        flush()
    }

    func writeSilence(_ frames: Int) {
        guard frames > 0 else { return }
        seashell_pcm_pipe_append_zeros(pipe, UInt64(frames) * 2)
        framesWritten += Int64(frames)
    }

    /// Real-time silence while macOS waits for the person to answer the prompt.
    func catchUpWithSilence() {
        let now = hostSeconds()
        if startedAt == nil { startedAt = now }
        let behind = Int64(((now - startedAt!) * rate).rounded()) - framesWritten
        if behind > 0 { writeSilence(Int(behind)) }
        flush()
    }

    func flush() {
        guard !readerGone else { return }
        if seashell_pcm_pipe_flush(pipe) < 0 {
            readerGone = true
            onReaderGone() // The reader closed the pipe: capture stopped.
        }
    }

    /// Waits at most timeoutMs for the reader to take everything queued.
    @discardableResult
    func deliver(timeoutMs: Int32) -> Bool {
        closeReplaced()
        guard !readerGone else { return false }
        let result = seashell_pcm_pipe_drain(pipe, timeoutMs)
        if result < 0 { readerGone = true; onReaderGone() }
        return result == 0
    }

    private func closeReplaced() {
        guard let stretch = replaced else { return }
        replaced = nil
        replacedFrames += stretch.frames
        report(String(format: "The recorder fell behind; %.1f s of microphone audio became silence.", Double(stretch.frames) / rate))
    }
}

// MARK: - Capture

/// A preallocated lock-free handoff out of the input tap (seashell-audio-ring.c).
private final class MicrophoneRing {
    /** At least this much of the input format, so a stalled consumer loses nothing for seconds. */
    static let seconds = 6.0
    let pointer: OpaquePointer

    init?(format: AVAudioFormat) {
        guard let pointer = seashell_audio_ring_create(format.streamDescription, MicrophoneRing.seconds, 32 << 20) else { return nil }
        self.pointer = pointer
    }

    deinit { seashell_audio_ring_destroy(pointer) }

    /// All the tap block does: copy the buffer, with its format, or count it as dropped.
    func write(_ buffer: AVAudioPCMBuffer) {
        _ = seashell_audio_ring_write(pointer, buffer.audioBufferList, buffer.frameLength, nil, buffer.format.streamDescription)
    }
}

private func sameFormat(_ a: AudioStreamBasicDescription, _ b: AudioStreamBasicDescription) -> Bool {
    a.mSampleRate == b.mSampleRate && a.mFormatID == b.mFormatID && a.mFormatFlags == b.mFormatFlags &&
        a.mBytesPerPacket == b.mBytesPerPacket && a.mFramesPerPacket == b.mFramesPerPacket &&
        a.mBytesPerFrame == b.mBytesPerFrame && a.mChannelsPerFrame == b.mChannelsPerFrame &&
        a.mBitsPerChannel == b.mBitsPerChannel
}

/// Everything after the tap, on one queue: each engine's ring in turn, the
/// conversion to mono at the capture rate, and the stream on stdout. Each
/// engine gets its own ring, so a stopping engine's last buffer and a new
/// engine's first never share one. An engine's ring is read empty and let go
/// once a newer engine's arrives, which happens only after it stopped.
private final class MicrophoneConsumer {
    private let output: PcmOutput
    private let target: AVAudioFormat
    private var rings: [MicrophoneRing] = []
    private var converter: MonoConverter?
    private var inputDescription = AudioStreamBasicDescription()
    private var scratch: AVAudioPCMBuffer?
    private var unsupported: AudioStreamBasicDescription?
    private var lastCapturedAt: Double = 0
    /** Silence standing in for frames the tap could not hand over. */
    private(set) var droppedSilenceFrames: Int64 = 0

    init(output: PcmOutput, target: AVAudioFormat) {
        self.output = output
        self.target = target
    }

    func add(_ ring: MicrophoneRing) { rings.append(ring) }

    func drain() {
        while let ring = rings.first {
            var record = seashell_audio_record()
            while seashell_audio_ring_peek(ring.pointer, &record) { consume(ring, &record) }
            guard rings.count > 1 else { break }
            writeDropped(seashell_audio_ring_take_trailing_drops(ring.pointer), rate: inputDescription.mSampleRate)
            rings.removeFirst()
        }
        output.flush()
    }

    /// The tap has stopped: everything it handed over goes out, and the resampler's tail with it.
    func settle() {
        drain()
        if let ring = rings.last {
            writeDropped(seashell_audio_ring_take_trailing_drops(ring.pointer), rate: inputDescription.mSampleRate)
        }
        finishConverter()
        output.flush()
    }

    private func outputFrames(_ inputFrames: UInt64, rate: Double) -> Int {
        guard rate > 0 else { return 0 }
        return Int((Double(inputFrames) * target.sampleRate / rate).rounded())
    }

    private func writeDropped(_ inputFrames: UInt64, rate: Double) {
        let frames = outputFrames(inputFrames, rate: rate)
        guard frames > 0 else { return }
        droppedSilenceFrames += Int64(frames)
        output.writeSilence(frames)
    }

    private func finishConverter() {
        guard let tail = converter?.finish(), let samples = tail.int16ChannelData?[0] else { return }
        output.write(samples, frames: Int(tail.frameLength), capturedAt: lastCapturedAt)
    }

    private func consume(_ ring: MicrophoneRing, _ record: inout seashell_audio_record) {
        if converter == nil || !sameFormat(inputDescription, record.format) {
            var description = record.format
            // More than two channels need a layout; a discrete one keeps every channel where it is.
            let layout = description.mChannelsPerFrame > 2
                ? AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | description.mChannelsPerFrame) : nil
            let format = layout.map { AVAudioFormat(streamDescription: &description, channelLayout: $0) }
                ?? AVAudioFormat(streamDescription: &description)
            guard let format, let next = MonoConverter(from: format, to: target) else {
                if unsupported.map({ !sameFormat($0, record.format) }) ?? true {
                    unsupported = record.format
                    say("Cannot convert microphone audio from \(description.mChannelsPerFrame) channels at \(description.mSampleRate) Hz.")
                }
                _ = seashell_audio_ring_read(ring.pointer, &record, nil)
                return
            }
            finishConverter()
            converter = next
            inputDescription = record.format
            scratch = nil
        }
        guard let converter else { return }
        if scratch.map({ $0.frameCapacity < record.frames }) ?? true {
            scratch = AVAudioPCMBuffer(pcmFormat: converter.input, frameCapacity: max(record.frames, 4_096))
        }
        let dropped = outputFrames(record.droppedFramesBefore, rate: record.format.mSampleRate)
        droppedSilenceFrames += Int64(dropped)
        lastCapturedAt = hostSeconds(record.storedHostTime)
        guard let scratch else {
            _ = seashell_audio_ring_read(ring.pointer, &record, nil)
            writeDropped(UInt64(record.frames), rate: record.format.mSampleRate)
            output.writeSilence(dropped)
            return
        }
        scratch.frameLength = min(record.frames, scratch.frameCapacity)
        guard seashell_audio_ring_read(ring.pointer, &record, scratch.mutableAudioBufferList) else {
            writeDropped(UInt64(record.frames), rate: record.format.mSampleRate)
            output.writeSilence(dropped)
            return
        }
        guard let converted = converter.convert(scratch), let samples = converted.int16ChannelData?[0] else {
            output.writeSilence(dropped)
            return
        }
        output.write(samples, frames: Int(converted.frameLength), capturedAt: lastCapturedAt, droppedBefore: dropped)
    }
}

private final class MicrophoneRecorder {
    /** How long input changes must settle before one rebuild: a burst of notifications is one change. */
    static let settleSeconds = 0.5
    private let format: AVAudioFormat
    private let output: PcmOutput
    private let consumer: MicrophoneConsumer
    /** Conversion and stdout: below the audio threads, above everything else here. */
    let consumerQueue = DispatchQueue(label: "com.seashell.microphone.consumer", qos: .userInitiated)
    private var consumerTimer: DispatchSourceTimer?
    private var engine: AVAudioEngine?
    /** Recording the --device-uid device rather than the default input. */
    private var usingPinnedDevice = false
    private var pinnedDeviceMissingSaid = false
    private var rebuildWork: DispatchWorkItem?
    private var configurationObserver: NSObjectProtocol?
    private var engineWatch: DispatchSourceTimer?
    private var defaultInputListener: AudioObjectPropertyListenerBlock?
    private var defaultInputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    private var devicesListener: AudioObjectPropertyListenerBlock?
    private var devicesAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    init(output: PcmOutput, rate: Double) {
        self.format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
        self.output = output
        self.consumer = MicrophoneConsumer(output: output, target: format)
    }

    func start() throws {
        try startEngine()
        let consumer = self.consumer
        let timer = DispatchSource.makeTimerSource(queue: consumerQueue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(5))
        timer.setEventHandler { consumer.drain() }
        timer.resume()
        consumerTimer = timer
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            // The selected microphone does not follow the default.
            guard let self, !self.usingPinnedDevice else { return }
            self.scheduleRebuild("default input changed")
        }
        defaultInputListener = listener
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultInputAddress, .main, listener)
        if deviceUID != nil {
            let devices: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                guard let self else { return }
                let present = pinnedDeviceID() != nil
                if present != self.usingPinnedDevice {
                    self.scheduleRebuild(present ? "selected microphone connected" : "selected microphone disconnected")
                }
            }
            devicesListener = devices
            AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, .main, devices)
        }
        // Rebuild an engine that stopped. Late or missing buffers alone are not
        // a reason: under load they are this Mac being busy, and a rebuild
        // would only add a device restart to it.
        let watch = DispatchSource.makeTimerSource(queue: .main)
        watch.schedule(deadline: .now() + 1, repeating: 1)
        watch.setEventHandler { [weak self] in
            guard let self, self.rebuildWork == nil, let engine = self.engine, !engine.isRunning else { return }
            self.scheduleRebuild("input engine stopped")
        }
        watch.resume()
        engineWatch = watch
    }

    func stop() {
        engineWatch?.cancel()
        rebuildWork?.cancel()
        rebuildWork = nil
        if let listener = defaultInputListener {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultInputAddress, .main, listener)
        }
        if let listener = devicesListener {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, .main, listener)
        }
        stopEngine()
        consumerTimer?.cancel()
        let consumer = self.consumer, output = self.output
        consumerQueue.sync {
            consumer.settle()
            output.deliver(timeoutMs: 750)
        }
    }

    /// Opens the --device-uid device on this engine's input, when it is connected.
    private func pinInputDevice(_ input: AVAudioInputNode) -> Bool {
        guard let uid = deviceUID else { return false }
        guard let deviceID = pinnedDeviceID() else {
            if !pinnedDeviceMissingSaid { say("Microphone \(uid) is not connected; recording the default input.") }
            pinnedDeviceMissingSaid = true
            return false
        }
        var device = deviceID
        let status = input.audioUnit.map {
            AudioUnitSetProperty($0, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                 &device, UInt32(MemoryLayout<AudioDeviceID>.size))
        } ?? kAudioUnitErr_Uninitialized
        guard status == noErr else {
            say("Could not open microphone \(uid) (\(status)); recording the default input.")
            return false
        }
        pinnedDeviceMissingSaid = false
        return true
    }

    private func startEngine() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let pinned = pinInputDevice(input)
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw NSError(domain: "SeashellMicrophone", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No microphone input is available. Check Sound → Input.",
            ])
        }
        guard MonoConverter(from: inputFormat, to: format) != nil else {
            throw NSError(domain: "SeashellMicrophone", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Cannot convert microphone audio from \(inputFormat).",
            ])
        }
        guard let ring = MicrophoneRing(format: inputFormat) else {
            throw NSError(domain: "SeashellMicrophone", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Not enough memory to record the microphone.",
            ])
        }
        // No tap format: the engine delivers whatever the device now sends. A
        // route change can switch formats before the engine reports it, and a
        // fixed tap format that no longer matches the hardware raises. Each
        // buffer carries its format through the ring instead. The block only
        // copies: conversion, allocation and stdout wait on the consumer queue.
        input.installTap(onBus: 0, bufferSize: 4_096, format: nil) { buffer, _ in ring.write(buffer) }
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in self?.scheduleRebuild("audio configuration changed") }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
            configurationObserver = nil
            throw error
        }
        let consumer = self.consumer
        consumerQueue.async { consumer.add(ring) }
        self.engine = engine
        usingPinnedDevice = pinned
    }

    private func stopEngine() {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
    }

    /// Restarting a running engine is unreliable after a route change; build a
    /// new one once the changes settle, so a burst of them is one rebuild.
    private func scheduleRebuild(_ reason: String, after delay: Double = MicrophoneRecorder.settleSeconds) {
        rebuildWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.rebuild(reason) }
        rebuildWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func rebuild(_ reason: String) {
        rebuildWork = nil
        stopEngine()
        do { try startEngine() } catch {
            say("Microphone \(reason); retrying: \(error.localizedDescription)")
            scheduleRebuild(reason, after: 1)
        }
    }
}

/// The input device --device-uid names, while it is connected and has input.
private func pinnedDeviceID() -> AudioDeviceID? {
    guard let uid = deviceUID else { return nil }
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var qualifier = uid as CFString
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = withUnsafeMutablePointer(to: &qualifier) { pointer in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                   UInt32(MemoryLayout<CFString>.size), pointer, &size, &deviceID)
    }
    guard status == noErr, deviceID != kAudioObjectUnknown else { return nil }
    var streams = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreams,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain)
    var streamsSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &streams, 0, nil, &streamsSize) == noErr, streamsSize > 0 else { return nil }
    return deviceID
}

// MARK: - Self-test

/** Reads a pipe on its own thread until the writer closes it. */
private final class PipeReader {
    private let fd: Int32
    private(set) var bytes: [UInt8] = []
    private let done = DispatchSemaphore(value: 0)

    init(fd: Int32) { self.fd = fd }

    func start() {
        Thread { [self] in
            var chunk = [UInt8](repeating: 0, count: 65_536)
            while true {
                let count = read(fd, &chunk, chunk.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                bytes.append(contentsOf: chunk[0..<count])
            }
            done.signal()
        }.start()
    }

    func wait() { done.wait() }
}

private func rounded(_ value: Double) -> Double { (value * 100).rounded() / 100 }

/// The handoff on synthetic buffers, as the tap delivers them. The ring, from
/// a time-constraint thread while nothing reads it; stdout, while nothing reads
/// it; and the whole consumer on a 440 Hz tone, with the consumer and the
/// reader stalled in turn and an engine rebuilt midway. No device is opened.
private func handoffCheck(target: AVAudioFormat, failures: inout [[String: Any]]) -> [String: Any] {
    // The built-in microphone's shape: three Float32 channels, one buffer each, 100 ms per buffer.
    let layout = AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 3)!
    let tap = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, interleaved: false, channelLayout: layout)
    var ring = seashell_ring_check()
    _ = seashell_ring_check_run(tap.streamDescription, 4_800, false, &ring)
    let ringChecks: [(String, Bool)] = [
        ("the tap never waits for a stalled consumer", ring.producerFinished),
        ("the ring holds at least 4 s", ring.ringSeconds >= 4),
        ("every dropped frame is counted", ring.droppedFrames > 0 && ring.countedDrops == ring.droppedFrames),
        ("every frame comes out once, in order, with gaps where frames were dropped", ring.orderKept),
        ("the same with both threads running", ring.concurrentOrderKept),
        ("a write takes under 2 ms", !ring.realtime || ring.maxWriteMicroseconds < 2_000),
    ]
    for (name, passed) in ringChecks where !passed { failures.append(["case": "handoff · ring", "error": name]) }
    var stdout = seashell_pipe_check()
    _ = seashell_pipe_check_run(Int(PcmOutput.seconds * target.sampleRate) * 2, 3_200, &stdout)
    let pipeChecks: [(String, Bool)] = [
        ("stdout is non-blocking", stdout.nonblocking),
        ("no write waits for a reader that is away", stdout.writerFinished),
        ("what does not fit is replaced", stdout.replacedBytes > 0),
        ("the stream keeps its length", stdout.lengthKept),
        ("every byte is where it was written, or silence where it was replaced", stdout.orderKept),
        ("out of marks, audio turns to silence in place", stdout.marksExhaustedInPlace),
        ("a closed reader is reported, not fatal", stdout.readerGoneDetected),
    ]
    for (name, passed) in pipeChecks where !passed { failures.append(["case": "handoff · stdout", "error": name]) }

    var descriptors: [Int32] = [0, 0]
    guard pipe(&descriptors) == 0,
          let output = PcmOutput(rate: target.sampleRate, output: descriptors[1], seconds: 4, onReaderGone: {}, report: { _ in }),
          let first = MicrophoneRing(format: tap), let second = MicrophoneRing(format: tap),
          let buffer = AVAudioPCMBuffer(pcmFormat: tap, frameCapacity: 4_800) else {
        failures.append(["case": "handoff · pipeline", "error": "could not set up"])
        return [:]
    }
    let consumer = MicrophoneConsumer(output: output, target: target)
    consumer.add(first)
    buffer.frameLength = 4_800
    var pushed = 0
    func push(_ ring: MicrophoneRing, seconds: Double, drainEvery: Int?) {
        let buffers = Int(seconds * tap.sampleRate / 4_800)
        for index in 0..<buffers {
            // Only the first channel is live, like a microphone array's spare inputs.
            let channels = buffer.floatChannelData!
            for frame in 0..<4_800 {
                channels[0][frame] = Float(0.25 * sin(2 * Double.pi * 440 * Double(pushed + frame) / tap.sampleRate))
                channels[1][frame] = 0
                channels[2][frame] = 0
            }
            ring.write(buffer)
            pushed += 4_800
            if let drainEvery, index % drainEvery == drainEvery - 1 { consumer.drain() }
        }
        if drainEvery != nil { consumer.drain() }
    }
    // Nobody reads stdout; the consumer stalls past what the ring holds, then catches up.
    push(first, seconds: 5, drainEvery: 2)
    push(first, seconds: 12, drainEvery: nil)
    consumer.drain()
    let reader = PipeReader(fd: descriptors[0])
    reader.start()
    let delivered = output.deliver(timeoutMs: 5_000)
    push(first, seconds: 3, drainEvery: 2)
    // An engine rebuild: the next audio arrives in a new ring.
    consumer.add(second)
    push(second, seconds: 2, drainEvery: 2)
    consumer.settle()
    let finished = output.deliver(timeoutMs: 5_000)
    close(descriptors[1])
    reader.wait()
    close(descriptors[0])

    let samples: [Int16] = reader.bytes.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    // Gaps are runs of exact silence; a 440 Hz tone has none longer than a sample or two.
    var silent: [Range<Int>] = []
    var runStart: Int?
    for index in 0...samples.count {
        let zero = index < samples.count && samples[index] == 0
        if zero, runStart == nil { runStart = index }
        if !zero, let start = runStart {
            if index - start >= 160 { silent.append(start..<index) }
            runStart = nil
        }
    }
    let silentFrames = silent.reduce(0) { $0 + $1.count }
    var windows = 0, quietWindows = 0, windowsAfterGaps = 0
    var window = 0
    while window + 1_600 <= samples.count {
        let range = window..<(window + 1_600)
        if !silent.contains(where: { $0.overlaps(range) }) {
            windows += 1
            if window >= (silent.last?.upperBound ?? 0) { windowsAfterGaps += 1 }
            if (samples[range].map { abs(Int32($0)) }.max() ?? 0) < 7_000 { quietWindows += 1 }
        }
        window += 1_600
    }
    let expectedFrames = Double(pushed) * target.sampleRate / tap.sampleRate
    let accounted = Int(consumer.droppedSilenceFrames + output.replacedFrames)
    let checks: [(String, Bool)] = [
        ("the stream is as long as the audio pushed in", delivered && finished && abs(Double(samples.count) - expectedFrames) <= 4),
        ("frames the stalled consumer missed became silence", consumer.droppedSilenceFrames > 0),
        ("audio the stalled reader missed became silence", output.replacedFrames > 0),
        ("silence is exactly what was dropped or replaced", abs(silentFrames - accounted) <= 4),
        ("the tone is everywhere else, after the gaps and the rebuild too", windows > 0 && quietWindows == 0 && windowsAfterGaps >= 10),
    ]
    for (name, passed) in checks where !passed { failures.append(["case": "handoff · pipeline", "error": name]) }
    return [
        "ring": [
            "realtimeThread": ring.realtime, "seconds": rounded(ring.ringSeconds), "pushedFrames": ring.pushedFrames,
            "storedFrames": ring.storedFrames, "droppedFrames": ring.droppedFrames, "countedDrops": ring.countedDrops,
            "maxWriteMicroseconds": rounded(ring.maxWriteMicroseconds), "concurrentPackets": ring.concurrentPackets,
        ],
        "stdout": [
            "nonblocking": stdout.nonblocking, "bytes": stdout.bytes, "replacedBytes": stdout.replacedBytes,
            "maxAppendMicroseconds": rounded(stdout.maxAppendMicroseconds),
        ],
        "pipeline": [
            "streamFrames": samples.count, "expectedFrames": Int(expectedFrames.rounded()),
            "droppedSilenceFrames": consumer.droppedSilenceFrames, "replacedFrames": output.replacedFrames,
            "silentFrames": silentFrames, "toneWindows": windows, "quietWindows": quietWindows,
        ],
    ]
}

// MARK: - Main

private let output: PcmOutput = {
    guard let output = PcmOutput(rate: sampleRate) else { fail("Not enough memory to record the microphone.") }
    return output
}()
private let recorder = MicrophoneRecorder(output: output, rate: sampleRate)
private var signalSources: [DispatchSourceSignal] = []
for value in [SIGINT, SIGTERM, SIGHUP] {
    signal(value, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
    source.setEventHandler { recorder.stop(); exit(0) }
    source.resume()
    signalSources.append(source)
}
if let durationSeconds {
    DispatchQueue.main.asyncAfter(deadline: .now() + durationSeconds) { recorder.stop(); exit(0) }
}

private func beginRecording() {
    do { try recorder.start() } catch { fail(error.localizedDescription) }
}

switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized:
    beginRecording()
case .notDetermined:
    // Keep the meeting timeline moving with silence while the prompt is open.
    let silence = DispatchSource.makeTimerSource(queue: recorder.consumerQueue)
    silence.schedule(deadline: .now(), repeating: 0.1)
    silence.setEventHandler { output.catchUpWithSilence() }
    silence.resume()
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        DispatchQueue.main.async {
            silence.cancel()
            if granted { beginRecording() } else { fail(permissionHelp, code: permissionExitCode) }
        }
    }
default:
    fail(permissionHelp, code: permissionExitCode)
}
dispatchMain()
