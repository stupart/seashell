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

import AVFoundation
import CoreAudio
import Darwin
import Foundation

private let disclaimedEnvironment = "SEASHELL_MICROPHONE_RESPONSIBLE"
private let permissionExitCode: Int32 = 77
private let usage = "Usage: seashell-microphone [--sample-rate HZ] [--seconds N] [--status | --request-permission] [--no-disclaim]"

private func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

private func argument(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

private let arguments = Array(CommandLine.arguments.dropFirst())
private let flags = ["--status", "--request-permission", "--no-disclaim"]
private let valued = ["--sample-rate", "--seconds"]
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
guard [8_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000].contains(sampleRate),
      durationSeconds == nil || durationSeconds! > 0 else { fail(usage, code: 2) }

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

/// Serializes stdout and keeps the stream aligned with elapsed wall time.
private final class PcmOutput {
    private let lock = NSLock()
    private let rate: Double
    private var startedAt: TimeInterval?
    private var framesWritten: Int64 = 0

    init(rate: Double) { self.rate = rate }

    func write(_ samples: UnsafePointer<Int16>, frames: Int) {
        lock.lock(); defer { lock.unlock() }
        let now = ProcessInfo.processInfo.systemUptime
        if let startedAt {
            // Device switches and engine rebuilds pause delivery. Fill the gap
            // so later speech keeps its true position in the meeting.
            let behind = Int64(((now - startedAt) * rate).rounded()) - Int64(frames) - framesWritten
            if behind > Int64(rate / 2) { writeSilenceLocked(Int(behind)) }
        } else {
            startedAt = now - Double(frames) / rate
        }
        writeAll(UnsafeRawPointer(samples), count: frames * 2)
        framesWritten += Int64(frames)
    }

    /// Real-time silence while macOS waits for the person to answer the prompt.
    func catchUpWithSilence() {
        lock.lock(); defer { lock.unlock() }
        let now = ProcessInfo.processInfo.systemUptime
        if startedAt == nil { startedAt = now }
        let behind = Int64(((now - startedAt!) * rate).rounded()) - framesWritten
        if behind > 0 { writeSilenceLocked(Int(behind)) }
    }

    private func writeSilenceLocked(_ frames: Int) {
        let block = [Int16](repeating: 0, count: min(frames, Int(rate)))
        var remaining = frames
        while remaining > 0 {
            let count = min(remaining, block.count)
            block.withUnsafeBytes { writeAll($0.baseAddress!, count: count * 2) }
            framesWritten += Int64(count)
            remaining -= count
        }
    }

    private func writeAll(_ bytes: UnsafeRawPointer, count: Int) {
        var offset = 0
        while offset < count {
            let written = Darwin.write(STDOUT_FILENO, bytes + offset, count - offset)
            if written < 0 {
                if errno == EINTR { continue }
                exit(0) // The reader closed the pipe: capture stopped.
            }
            offset += written
        }
    }
}

// MARK: - Capture

private final class MicrophoneRecorder {
    private let output: PcmOutput
    private let format: AVAudioFormat
    private var engine: AVAudioEngine?
    private var lastBufferAt = ProcessInfo.processInfo.systemUptime
    private var rebuildPending = false
    private var configurationObserver: NSObjectProtocol?
    private var stallTimer: DispatchSourceTimer?
    private var defaultInputListener: AudioObjectPropertyListenerBlock?
    private var defaultInputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)

    init(output: PcmOutput, rate: Double) {
        self.output = output
        self.format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: 1, interleaved: true)!
    }

    func start() throws {
        try startEngine()
        let listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
            self?.scheduleRebuild("default input changed")
        }
        defaultInputListener = listener
        AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultInputAddress, .main, listener)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, self.engine != nil,
                  ProcessInfo.processInfo.systemUptime - self.lastBufferAt > 3 else { return }
            self.scheduleRebuild("input stopped delivering audio")
        }
        timer.resume()
        stallTimer = timer
    }

    func stop() {
        stallTimer?.cancel()
        if let listener = defaultInputListener {
            AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &defaultInputAddress, .main, listener)
        }
        stopEngine()
    }

    private func startEngine() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw NSError(domain: "SeashellMicrophone", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "No microphone input is available. Check Sound → Input.",
            ])
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: format) else {
            throw NSError(domain: "SeashellMicrophone", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Cannot convert microphone audio from \(inputFormat).",
            ])
        }
        converter.downmix = true
        let output = self.output
        let format = self.format
        input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
            self?.lastBufferAt = ProcessInfo.processInfo.systemUptime
            let capacity = AVAudioFrameCount((Double(buffer.frameLength) * format.sampleRate / inputFormat.sampleRate).rounded(.up)) + 64
            guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, inputStatus in
                if supplied { inputStatus.pointee = .noDataNow; return nil }
                supplied = true
                inputStatus.pointee = .haveData
                return buffer
            }
            guard status != .error, converted.frameLength > 0, let samples = converted.int16ChannelData?[0] else { return }
            output.write(samples, frames: Int(converted.frameLength))
        }
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
        lastBufferAt = ProcessInfo.processInfo.systemUptime
        self.engine = engine
    }

    private func stopEngine() {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        configurationObserver = nil
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
    }

    /// Restarting a running engine is unreliable after a route change; build a new one.
    private func scheduleRebuild(_ reason: String) {
        guard !rebuildPending else { return }
        rebuildPending = true
        stopEngine()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            self.rebuildPending = false
            do { try self.startEngine() } catch {
                FileHandle.standardError.write(Data("Microphone \(reason); retrying: \(error.localizedDescription)\n".utf8))
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.scheduleRebuild(reason) }
            }
        }
    }
}

private let output = PcmOutput(rate: sampleRate)
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
    let silence = DispatchSource.makeTimerSource(queue: .main)
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
