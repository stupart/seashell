import AVFoundation
import FluidAudio
import Foundation

// seashell-speakers: local speaker separation on the Neural Engine, no Python.
//
//   seashell-speakers <audio> [--channel-roles local,remote] [--num-speakers N |
//                     --min-speakers N --max-speakers N]
//   seashell-speakers --status     models present? (never touches the network)
//   seashell-speakers --prepare    download the models once (about 21 MB)
//
// Output is the JSON scripts/diarize.py prints, so src/diarize.ts reads either:
// { model, device, channels, turns: [{ start, end, speaker, role? }], speakers: [{ id, label }] }.
// Measured on four AMI meetings: diarization error 10.0% against 8.8% for the
// Python pipeline, about 5x faster, 21 MB of models instead of a 1 GB install.

let modelName = "fluidaudio/speaker-diarization-coreml (pyannote community-1)"
let requiredFiles = [
    "Segmentation.mlmodelc", "Embedding.mlmodelc", "PldaRho.mlmodelc", "FBank.mlmodelc", "plda-parameters.json",
]

// FluidAudio writes profiling lines to stderr unasked, and Seashell shows this
// helper's stderr as status. Keep the real stderr for our own words and send
// the process's stderr to /dev/null.
let messages = FileHandle(fileDescriptor: dup(STDERR_FILENO), closeOnDealloc: true)
let devNull = open("/dev/null", O_WRONLY)
if devNull >= 0 { dup2(devNull, STDERR_FILENO); close(devNull) }
AppLogger.minimumLevel = .error

func fail(_ message: String, code: Int32 = 1) -> Never {
    messages.write(Data((message + "\n").utf8))
    exit(code)
}

func note(_ message: String) {
    messages.write(Data((message + "\n").utf8))
}

func emit(_ value: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
        fail("Could not encode the result")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

/// Seashell's own copy, so removing another app's cache never breaks it.
func modelsRoot() -> URL {
    if let configured = ProcessInfo.processInfo.environment["SEASHELL_SPEAKER_MODELS"], !configured.isEmpty {
        return URL(fileURLWithPath: configured, isDirectory: true)
    }
    return FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Sea Shell/Speakers", isDirectory: true)
}

func modelsReady(_ root: URL) -> Bool {
    let directory = root.appendingPathComponent("speaker-diarization", isDirectory: true)
    return requiredFiles.allSatisfy { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0).path) }
}

func status(_ root: URL) -> [String: Any] {
    let ready = modelsReady(root)
    return [
        "ready": ready,
        "model": modelName,
        "directory": root.appendingPathComponent("speaker-diarization").path,
        "nextStep": ready ? NSNull() : "Run: seashell setup --speakers",
    ]
}

// MARK: - Arguments

struct Options {
    var audio: String?
    var roles: [String]?
    var numSpeakers: Int?
    var minSpeakers: Int?
    var maxSpeakers: Int?
}

func positive(_ raw: String?, _ name: String) -> Int {
    guard let raw, let value = Int(raw), value >= 1 else { fail("\(name) must be at least 1") }
    return value
}

func parse(_ arguments: [String]) -> Options {
    var options = Options()
    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        let next: () -> String? = { index += 1; return index < arguments.count ? arguments[index] : nil }
        switch argument {
        case "--channel-roles":
            guard let raw = next() else { fail("--channel-roles needs a value") }
            options.roles = raw.split(separator: ",", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        case "--num-speakers": options.numSpeakers = positive(next(), "--num-speakers")
        case "--min-speakers": options.minSpeakers = positive(next(), "--min-speakers")
        case "--max-speakers": options.maxSpeakers = positive(next(), "--max-speakers")
        default:
            if argument.hasPrefix("-") { fail("Unknown option \(argument)") }
            if options.audio != nil { fail("Give one audio file") }
            options.audio = argument
        }
        index += 1
    }
    if options.numSpeakers != nil && (options.minSpeakers != nil || options.maxSpeakers != nil) {
        fail("--num-speakers cannot be combined with --min-speakers/--max-speakers")
    }
    if let low = options.minSpeakers, let high = options.maxSpeakers, low > high {
        fail("--min-speakers cannot exceed --max-speakers")
    }
    if let roles = options.roles {
        if roles.contains(where: \.isEmpty) { fail("--channel-roles cannot contain an empty role") }
        if Set(roles).count != roles.count { fail("--channel-roles must be unique") }
        if Set(roles.map(prefix)).count != roles.count { fail("--channel-roles normalize to colliding speaker ID prefixes") }
    }
    return options
}

func prefix(_ role: String) -> String {
    let cleaned = role.uppercased().replacingOccurrences(of: "[^A-Z0-9]+", with: "_", options: .regularExpression)
        .trimmingCharacters(in: CharacterSet(charactersIn: "_"))
    return cleaned.isEmpty ? "CHANNEL" : cleaned
}

// MARK: - Audio

/// Every channel of the file at 16 kHz, read in blocks so a long meeting is never held twice.
func channels(of url: URL, sampleRate target: Double) throws -> [[Float]] {
    let file = try AVAudioFile(forReading: url)
    let source = file.processingFormat
    let count = Int(source.channelCount)
    guard count > 0 else { fail("The audio has no channels") }
    guard let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: source.sampleRate, channels: 1, interleaved: false),
          let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: target, channels: 1, interleaved: false) else {
        fail("Unsupported audio format")
    }
    let converters = (0..<count).map { _ in AVAudioConverter(from: mono, to: output) }
    var result = Array(repeating: [Float](), count: count)
    let block: AVAudioFrameCount = 65_536
    guard let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: block) else { fail("Out of memory") }

    /// Push one block of one channel through its converter; `nil` flushes what it still holds.
    func convert(_ channel: Int, _ frames: AVAudioFrameCount?) throws {
        guard let converter = converters[channel],
              let converted = AVAudioPCMBuffer(pcmFormat: output,
                  frameCapacity: AVAudioFrameCount(Double(frames ?? 0) * target / source.sampleRate) + 4_096)
        else { fail("Could not prepare audio conversion") }
        var single: AVAudioPCMBuffer?
        if let frames {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: max(1, frames)) else { fail("Out of memory") }
            buffer.frameLength = frames
            if let from = input.floatChannelData?[channel], let to = buffer.floatChannelData?[0] {
                to.update(from: from, count: Int(frames))
            }
            single = buffer
        }
        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            guard let single else { status.pointee = .endOfStream; return nil }
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return single
        }
        if let error { throw error }
        if let data = converted.floatChannelData?[0] {
            result[channel].append(contentsOf: UnsafeBufferPointer(start: data, count: Int(converted.frameLength)))
        }
    }

    // Reading past the end throws rather than returning nothing: read only what remains.
    while file.framePosition < file.length {
        let frames = AVAudioFrameCount(min(Int64(block), file.length - file.framePosition))
        try file.read(into: input, frameCount: frames)
        for channel in 0..<count { try convert(channel, input.frameLength) }
    }
    for channel in 0..<count { try convert(channel, nil) }
    return result
}

// MARK: - Turns

struct Turn {
    var start: Double
    var end: Double
    var speaker: String
    var role: String?
}

/// Same merge as diarize.py: one speaker's turns closer than 50 ms become one.
func coalesce(_ turns: [Turn]) -> [Turn] {
    var merged: [Turn] = []
    for turn in turns.sorted(by: { ($0.start, $0.end, $0.speaker) < ($1.start, $1.end, $1.speaker) }) {
        if var previous = merged.last, previous.speaker == turn.speaker, previous.role == turn.role,
           turn.start <= previous.end + 0.05 {
            previous.end = max(previous.end, turn.end)
            merged[merged.count - 1] = previous
        } else {
            merged.append(turn)
        }
    }
    return merged
}

func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }

// MARK: - Main

let arguments = Array(CommandLine.arguments.dropFirst())
let root = modelsRoot()

if arguments == ["--version"] {
    print("seashell-speakers 1 (FluidAudio 0.17.7)")
    exit(0)
}
if arguments == ["--status"] {
    emit(status(root))
    exit(0)
}
if arguments == ["--prepare"] {
    note("Downloading speaker models (about 21 MB)…")
    do {
        _ = try await OfflineDiarizerModels.load(from: root)
    } catch {
        fail("Could not download the speaker models: \(error.localizedDescription)")
    }
    emit(status(root))
    exit(modelsReady(root) ? 0 : 1)
}

let options = parse(arguments)
guard let path = options.audio else {
    fail("Usage: seashell-speakers <audio> [--channel-roles local,remote] [--num-speakers N | --min-speakers N --max-speakers N]")
}
guard FileManager.default.fileExists(atPath: path) else { fail("Audio file not found: \(path)") }
// Separation runs after meetings, possibly offline: never download here.
guard modelsReady(root) else { fail("Speaker models are not downloaded. Run: seashell setup --speakers", code: 2) }

var config = OfflineDiarizerConfig.default
// The accurate preset: a 10% segmentation step and no minimum segment, which
// measured 1.3 points better than FluidAudio's faster default on AMI.
config.segmentation.stepRatio = 0.1
config.embedding.minSegmentDurationSeconds = 0
let fixed = (options.roles?.contains("local") ?? false) ? 1 : 0
let modelled = options.roles.map { $0.filter { $0 != "local" }.count } ?? 1
if modelled > 1 && (options.numSpeakers ?? options.minSpeakers ?? options.maxSpeakers) != nil {
    fail("Speaker-count options are ambiguous with multiple model-processed channels; provide one remote channel or omit the constraint")
}
if let exactly = options.numSpeakers {
    guard exactly - fixed >= 1 else { fail("--num-speakers must leave at least one speaker for the model-processed channel") }
    config = config.withSpeakers(exactly: exactly - fixed)
} else if options.minSpeakers != nil || options.maxSpeakers != nil {
    let low = options.minSpeakers.map { $0 - fixed }.flatMap { $0 >= 1 ? $0 : nil }
    if let high = options.maxSpeakers, high - fixed < 1 {
        fail("--max-speakers must leave at least one speaker for the model-processed channel")
    }
    config = config.withSpeakers(min: low, max: options.maxSpeakers.map { $0 - fixed })
}

note("Loading speaker models…")
let manager = OfflineDiarizerManager(config: config)
do {
    manager.initialize(models: try await OfflineDiarizerModels.load(from: root))
} catch {
    fail("Could not load the speaker models: \(error.localizedDescription). Run: seashell setup --speakers")
}

let audio: [[Float]]
do {
    audio = try channels(of: URL(fileURLWithPath: path), sampleRate: Double(config.segmentation.sampleRate))
} catch {
    fail("Could not read \(path): \(error.localizedDescription)")
}
if let roles = options.roles, roles.count != audio.count {
    fail("--channel-roles listed \(roles.count) roles, but the WAV has \(audio.count) channels")
}

note("Separating speakers…")
var turns: [Turn] = []
var speakers: [String: String] = [:]

func separate(_ samples: [Float], role: String?) async throws {
    let result: DiarizationResult
    do {
        result = try await manager.process(audio: samples)
    } catch OfflineDiarizationError.noSpeechDetected {
        return
    }
    var identities: [String: String] = [:]
    for segment in result.segments.sorted(by: { $0.startTimeSeconds < $1.startTimeSeconds }) {
        let id: String
        let label: String
        if let role {
            if identities[segment.speakerId] == nil {
                identities[segment.speakerId] = "\(prefix(role))_\(String(format: "%02d", identities.count))"
            }
            id = identities[segment.speakerId]!
            label = "\(role) \(Int(id.split(separator: "_").last!)! + 1)"
        } else {
            if identities[segment.speakerId] == nil {
                identities[segment.speakerId] = "SPEAKER_\(String(format: "%02d", identities.count))"
            }
            id = identities[segment.speakerId]!
            label = id
        }
        let start = max(0, Double(segment.startTimeSeconds))
        turns.append(Turn(start: round3(start), end: round3(max(start, Double(segment.endTimeSeconds))), speaker: id, role: role))
        speakers[id] = label
    }
}

do {
    if let roles = options.roles {
        // A channel's role is a stronger prior than clustering voices: never mix them.
        for (index, role) in roles.enumerated() {
            if role == "local" {
                speakers["LOCAL"] = "local"
                continue
            }
            try await separate(audio[index], role: role)
        }
    } else {
        let frames = audio.map(\.count).max() ?? 0
        var mono = [Float](repeating: 0, count: frames)
        for channel in audio {
            for index in channel.indices { mono[index] += channel[index] / Float(audio.count) }
        }
        try await separate(mono, role: nil)
    }
} catch {
    fail("Speaker separation failed: \(error.localizedDescription)")
}

emit([
    "model": modelName,
    "device": "ane",
    "channels": audio.count,
    "turns": coalesce(turns).map { turn -> [String: Any] in
        var value: [String: Any] = ["start": turn.start, "end": turn.end, "speaker": turn.speaker]
        if let role = turn.role { value["role"] = role }
        return value
    },
    "speakers": speakers.keys.sorted().map { ["id": $0, "label": speakers[$0]!] },
])
