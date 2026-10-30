import AVFoundation
import FluidAudio
import Foundation

// seashell-speakers: local speaker separation on the Neural Engine, no Python.
//
//   seashell-speakers <audio> [--engine community-1|nemotron3]
//                     [--channel-roles local,remote]
//                     [--num-speakers N | --min-speakers N --max-speakers N]
//   seashell-speakers --status [--engine …]    models present? (never touches the network)
//   seashell-speakers --prepare [--engine …]   download once (21 MB, or 190 MB for Nemotron 3)
//
// Output is the JSON scripts/diarize.py prints, so src/diarize.ts reads either:
// { model, device, channels, turns: [{ start, end, speaker, role? }], speakers: [{ id, label }] }.
// Measured on four AMI meetings: diarization error 10.0% against 8.8% for the
// Python pipeline, about 5x faster, 21 MB of models instead of a 1 GB install.
// NVIDIA's Nemotron 3 is the optional second engine: on the same meetings it put
// the wrong name on 1.4% of words outside crosstalk against 4.7%, about 5x faster
// again, for 190 MB of models and a cap of eight voices per channel.

let modelName = "fluidaudio/speaker-diarization-coreml (pyannote community-1)"
let requiredFiles = [
    "Segmentation.mlmodelc", "Embedding.mlmodelc", "PldaRho.mlmodelc", "FBank.mlmodelc", "plda-parameters.json",
]
let nemotronModelName = "nvidia/nemotron-3-diarization (fast128, Core ML via FluidAudio)"
// fast128 tied the offline preset on words and runs on the Neural Engine.
let nemotronConfig = Nemotron3Config.fast128

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

func nemotronDirectory(_ root: URL) -> URL {
    root.appendingPathComponent("nemotron-3-diarization", isDirectory: true)
}

func nemotronReady(_ root: URL) -> Bool {
    let directory = nemotronDirectory(root)
    return ["\(nemotronConfig.hubSubdirectory)/\(nemotronConfig.modelFileName)", "learnable_sil_emb.bin"]
        .allSatisfy { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0).path) }
}

func nemotronStatus(_ root: URL) -> [String: Any] {
    let ready = nemotronReady(root)
    return [
        "ready": ready,
        "model": nemotronModelName,
        "directory": nemotronDirectory(root).path,
        "nextStep": ready ? NSNull() : "Run: seashell speakers use nemotron3",
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

var arguments = Array(CommandLine.arguments.dropFirst())
let root = modelsRoot()

// `--engine` picks the model everywhere, including --status and --prepare.
var useNemotron = false
if let index = arguments.firstIndex(of: "--engine") {
    guard index + 1 < arguments.count else { fail("--engine needs a value") }
    switch arguments[index + 1] {
    case "community-1": break
    case "nemotron3": useNemotron = true
    default: fail("--engine must be community-1 or nemotron3")
    }
    arguments.removeSubrange(index...(index + 1))
}

if arguments == ["--version"] {
    print("seashell-speakers 2 (FluidAudio 0.18.0)")
    exit(0)
}
if arguments == ["--status"] {
    emit(useNemotron ? nemotronStatus(root) : status(root))
    exit(0)
}
if arguments == ["--prepare"] {
    note("Downloading speaker models (about \(useNemotron ? 190 : 21) MB)…")
    do {
        if useNemotron {
            _ = try await Nemotron3Models.loadFromHuggingFace(config: nemotronConfig, cacheDirectory: root)
        } else {
            _ = try await OfflineDiarizerModels.load(from: root)
        }
    } catch {
        fail("Could not download the speaker models: \(error.localizedDescription)")
    }
    emit(useNemotron ? nemotronStatus(root) : status(root))
    exit((useNemotron ? nemotronReady(root) : modelsReady(root)) ? 0 : 1)
}

let options = parse(arguments)
guard let path = options.audio else {
    fail("Usage: seashell-speakers <audio> [--engine community-1|nemotron3] [--channel-roles local,remote] [--num-speakers N | --min-speakers N --max-speakers N]")
}
guard FileManager.default.fileExists(atPath: path) else { fail("Audio file not found: \(path)") }
// Separation runs after meetings, possibly offline: never download here.
if useNemotron {
    guard nemotronReady(root) else { fail("Nemotron 3 is not downloaded. Run: seashell speakers use nemotron3", code: 2) }
} else {
    guard modelsReady(root) else { fail("Speaker models are not downloaded. Run: seashell setup --speakers", code: 2) }
}

var config = OfflineDiarizerConfig.default
// The accurate preset: a 10% segmentation step and no minimum segment, which
// measured 1.3 points better than FluidAudio's faster default on AMI.
config.segmentation.stepRatio = 0.1
config.embedding.minSegmentDurationSeconds = 0
let fixed = (options.roles?.contains("local") ?? false) ? 1 : 0
let modelled = options.roles.map { $0.filter { $0 != "local" }.count } ?? 1
let constrained = (options.numSpeakers ?? options.minSpeakers ?? options.maxSpeakers) != nil
if modelled > 1 && constrained {
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
// Nemotron 3 finds the count itself and takes no hint, so a stated count goes to community-1.
if useNemotron && constrained {
    note("Nemotron 3 takes no speaker count; using community-1 for this file.")
    useNemotron = false
    guard modelsReady(root) else { fail("Speaker models are not downloaded. Run: seashell setup --speakers", code: 2) }
}

note("Loading speaker models…")
let manager = OfflineDiarizerManager(config: config)
var nemotron: Nemotron3Diarizer?
do {
    // community-1 is also the fallback when Nemotron 3 fills all eight slots.
    if modelsReady(root) { manager.initialize(models: try await OfflineDiarizerModels.load(from: root)) }
    if useNemotron {
        nemotron = Nemotron3Diarizer(config: nemotronConfig,
            models: try await Nemotron3Models.loadFromHuggingFace(config: nemotronConfig, cacheDirectory: root))
    }
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
var usedModel = useNemotron ? nemotronModelName : modelName

struct Span {
    var start: Double
    var end: Double
    var speaker: String
}

func community1(_ samples: [Float]) async throws -> [Span] {
    do {
        return try await manager.process(audio: samples).segments.map {
            Span(start: Double($0.startTimeSeconds), end: Double($0.endTimeSeconds), speaker: $0.speakerId)
        }
    } catch OfflineDiarizationError.noSpeechDetected {
        return []
    }
}

func separate(_ samples: [Float], role: String?) async throws {
    var spans: [Span]
    if let nemotron {
        let (probabilities, frames) = try nemotron.processComplete(samples)
        spans = Nemotron3Diarizer.segments(probabilities: probabilities, frameCount: frames).map {
            Span(start: Double($0.startSeconds), end: Double($0.endSeconds), speaker: String($0.speakerIndex))
        }
        // Every slot taken means the call may have more people than the model
        // can hold, and they would be merged. community-1 has no cap.
        if Set(spans.map(\.speaker)).count >= nemotronConfig.numSpeakers, modelsReady(root) {
            note("All eight speaker slots are in use; using community-1 for this channel.")
            usedModel = modelName
            spans = try await community1(samples)
        }
    } else {
        spans = try await community1(samples)
    }
    var identities: [String: String] = [:]
    for span in spans.sorted(by: { $0.start < $1.start }) {
        let id: String
        let label: String
        if let role {
            if identities[span.speaker] == nil {
                identities[span.speaker] = "\(prefix(role))_\(String(format: "%02d", identities.count))"
            }
            id = identities[span.speaker]!
            label = "\(role) \(Int(id.split(separator: "_").last!)! + 1)"
        } else {
            if identities[span.speaker] == nil {
                identities[span.speaker] = "SPEAKER_\(String(format: "%02d", identities.count))"
            }
            id = identities[span.speaker]!
            label = id
        }
        let start = max(0, span.start)
        turns.append(Turn(start: round3(start), end: round3(max(start, span.end)), speaker: id, role: role))
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
    "model": usedModel,
    "device": "ane",
    "channels": audio.count,
    "turns": coalesce(turns).map { turn -> [String: Any] in
        var value: [String: Any] = ["start": turn.start, "end": turn.end, "speaker": turn.speaker]
        if let role = turn.role { value["role"] = role }
        return value
    },
    "speakers": speakers.keys.sorted().map { ["id": $0, "label": speakers[$0]!] },
])
