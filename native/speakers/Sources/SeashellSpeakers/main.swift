import AVFoundation
import FluidAudio
import Foundation

// seashell-speakers: local speaker separation on the Neural Engine, no Python.
//
//   seashell-speakers <audio> [--engine auto|community-1|nemotron3]
//                     [--channel-roles local,remote]
//                     [--num-speakers N | --min-speakers N --max-speakers N]
//   seashell-speakers --status [--engine …]    models present? (never touches the network)
//   seashell-speakers --prepare [--engine …]   download once (211 MB; 21 MB for community-1
//                                              alone, 190 MB for Nemotron 3 alone)
//
// Output is the JSON scripts/diarize.py prints, so src/diarize.ts reads either:
// { model, device, channels, turns: [{ start, end, speaker, role? }], speakers: [{ id, label }] },
// plus voices: { <speaker id>: { embedding, seconds } } for recognising people across
// meetings (src/voiceprints.ts). Embeddings stay on this Mac like everything else.
//
// Two engines: pyannote's community-1 (offline VBx, no cap on voices; diarization
// error 10.0% on four AMI meetings against 8.8% for the Python pipeline, about 5x
// faster) and NVIDIA's Nemotron 3 (eight voices per channel, about 5x faster
// again). The default, auto, runs both and lets community-1 check Nemotron 3:
// see `choose` for why and the numbers.

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

/// Which model separates the voices. `auto`, the default, runs both and checks
/// one against the other: see `choose`.
enum Engine { case auto, community1, nemotron3 }

// `--engine` picks the model everywhere, including --status and --prepare.
var engine = Engine.auto
if let index = arguments.firstIndex(of: "--engine") {
    guard index + 1 < arguments.count else { fail("--engine needs a value") }
    switch arguments[index + 1] {
    case "auto": engine = .auto
    case "community-1": engine = .community1
    case "nemotron3": engine = .nemotron3
    default: fail("--engine must be auto, community-1 or nemotron3")
    }
    arguments.removeSubrange(index...(index + 1))
}

if arguments == ["--version"] {
    print("seashell-speakers 3 (FluidAudio 0.18.0)")
    exit(0)
}
if arguments == ["--status"] {
    switch engine {
    case .community1: emit(status(root))
    case .nemotron3: emit(nemotronStatus(root))
    // community-1 alone is enough to separate voices; Nemotron 3 makes it better.
    case .auto: emit(status(root).merging(["nemotron": nemotronReady(root)]) { $1 })
    }
    exit(0)
}
if arguments == ["--prepare"] {
    note("Downloading speaker models (about \(engine == .community1 ? 21 : engine == .nemotron3 ? 190 : 211) MB)…")
    do {
        if engine != .nemotron3 { _ = try await OfflineDiarizerModels.load(from: root) }
        if engine != .community1 {
            _ = try await Nemotron3Models.loadFromHuggingFace(config: nemotronConfig, cacheDirectory: root)
        }
    } catch {
        fail("Could not download the speaker models: \(error.localizedDescription)")
    }
    let ready = (engine == .nemotron3 || modelsReady(root)) && (engine == .community1 || nemotronReady(root))
    emit(engine == .nemotron3 ? nemotronStatus(root) : status(root))
    exit(ready ? 0 : 1)
}

let options = parse(arguments)
guard let path = options.audio else {
    fail("Usage: seashell-speakers <audio> [--engine auto|community-1|nemotron3] [--channel-roles local,remote] [--num-speakers N | --min-speakers N --max-speakers N]")
}
guard FileManager.default.fileExists(atPath: path) else { fail("Audio file not found: \(path)") }
// Separation runs after meetings, possibly offline: never download here.
if engine == .nemotron3 {
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
/// At most this many voices on the model-processed channel, when the caller knows.
let voiceLimit = options.maxSpeakers.map { $0 - fixed }
// Nemotron 3 finds the count itself and takes no hint, so a stated count goes to
// community-1. A ceiling alone is the exception: a call that may have more
// people than its eight slots skips Nemotron 3, and an answer over the ceiling
// is refused in `choose`.
let nemotronFits = options.numSpeakers == nil && options.minSpeakers == nil &&
    (voiceLimit ?? 0) <= nemotronConfig.numSpeakers
var useNemotron: Bool
switch engine {
case .community1: useNemotron = false
case .nemotron3:
    useNemotron = nemotronFits
    if !nemotronFits { note("Nemotron 3 can't take that speaker count; using community-1 for this file.") }
case .auto:
    useNemotron = nemotronReady(root) && nemotronFits
}
if !useNemotron && !modelsReady(root) {
    fail("Speaker models are not downloaded. Run: seashell setup --speakers", code: 2)
}

note("Loading speaker models…")
let manager = OfflineDiarizerManager(config: config)
var nemotron: Nemotron3Diarizer?
do {
    // community-1 is also the fallback when Nemotron 3 fills all eight slots,
    // and its embedding model gives every engine's voices their voiceprints.
    if modelsReady(root) { manager.initialize(models: try await OfflineDiarizerModels.load(from: root)) }
} catch {
    fail("Could not load the speaker models: \(error.localizedDescription). Run: seashell setup --speakers")
}
if useNemotron {
    do {
        nemotron = Nemotron3Diarizer(config: nemotronConfig,
            models: try await Nemotron3Models.loadFromHuggingFace(config: nemotronConfig, cacheDirectory: root))
    } catch {
        // auto has community-1's answer to stand on; only Nemotron 3 by itself has nothing else.
        guard engine == .auto else {
            fail("Could not load the speaker models: \(error.localizedDescription). Run: seashell setup --speakers")
        }
        note("Nemotron 3 could not load (\(error.localizedDescription)); using community-1.")
        useNemotron = false
    }
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
var voices: [String: [String: Any]] = [:]
var usedModels: [String] = []

struct Span {
    var start: Double
    var end: Double
    var speaker: String
}

struct Voice {
    var embedding: [Float]
    var seconds: Double
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

func nemotron3(_ samples: [Float], _ nemotron: Nemotron3Diarizer) throws -> [Span] {
    let (probabilities, frames) = try nemotron.processComplete(samples)
    return Nemotron3Diarizer.segments(probabilities: probabilities, frameCount: frames).map {
        Span(start: Double($0.startSeconds), end: Double($0.endSeconds), speaker: String($0.speakerIndex))
    }
}

func speech(_ spans: [Span], of speaker: String) -> Double {
    spans.filter { $0.speaker == speaker }.reduce(0) { $0 + $1.end - $1.start }
}

// MARK: - Voices

/// Pieces of one speaker's turns where nobody else is talking, longest first.
func cleanPieces(_ own: [Span], others: [Span]) -> [Range<Double>] {
    var pieces: [Range<Double>] = []
    for span in own {
        var remaining = [span.start..<max(span.start, span.end)]
        for other in others where other.start < span.end && other.end > span.start {
            remaining = remaining.flatMap { piece -> [Range<Double>] in
                guard other.start < piece.upperBound && other.end > piece.lowerBound else { return [piece] }
                return [piece.lowerBound..<max(piece.lowerBound, other.start), min(piece.upperBound, other.end)..<piece.upperBound]
                    .filter { !$0.isEmpty }
            }
        }
        pieces.append(contentsOf: remaining)
    }
    return pieces.sorted { ($0.upperBound - $0.lowerBound) > ($1.upperBound - $1.lowerBound) }
}

/// One voice embedding per speaker: up to a minute of their longest stretches
/// with nobody else talking, each at least a second, embedded with community-1's
/// embedding model and averaged. The same model judges both engines' speakers,
/// so a voice named in one meeting can be recognised in the next.
func embedVoices(_ samples: [Float], _ spans: [Span]) async -> [String: Voice] {
    guard modelsReady(root) else { return [:] }
    var chosen: [(speaker: String, range: Range<Double>)] = []
    for speaker in Set(spans.map(\.speaker)) {
        var total = 0.0
        for piece in cleanPieces(spans.filter { $0.speaker == speaker }, others: spans.filter { $0.speaker != speaker }) {
            let length = piece.upperBound - piece.lowerBound
            if length < 1 || total >= 60 { break }
            // Long turns are cut to ten seconds, one model window, so one turn can't dominate.
            let middle = (piece.lowerBound + piece.upperBound) / 2
            let range = length > 10 ? (middle - 5)..<(middle + 5) : piece
            chosen.append((speaker, range))
            total += range.upperBound - range.lowerBound
        }
    }
    guard !chosen.isEmpty,
          let embeddings = try? await manager.embedSpans(audioSource: ArrayAudioSampleSource(samples: samples), spans: chosen.map(\.range)),
          embeddings.count == chosen.count
    else { return [:] }
    var sums: [String: Voice] = [:]
    for (piece, embedding) in zip(chosen, embeddings) {
        let norm = sqrt(embedding.reduce(0) { $0 + $1 * $1 })
        guard norm > 0, norm.isFinite else { continue }
        var sum = sums[piece.speaker] ?? Voice(embedding: [Float](repeating: 0, count: embedding.count), seconds: 0)
        for index in embedding.indices { sum.embedding[index] += embedding[index] / norm }
        sum.seconds += piece.range.upperBound - piece.range.lowerBound
        sums[piece.speaker] = sum
    }
    return sums.compactMapValues { sum in
        let norm = sqrt(sum.embedding.reduce(0) { $0 + $1 * $1 })
        return norm > 0 ? Voice(embedding: sum.embedding.map { $0 / norm }, seconds: sum.seconds) : nil
    }
}

func similarity(_ left: Voice, _ right: Voice) -> Float {
    zip(left.embedding, right.embedding).reduce(0) { $0 + $1.0 * $1.1 }
}

// Measured on 13 AMI meetings (6.8 hours, 16 people, with and without 16 kbit/s
// Opus like a video call), comparing voices that had at least 10 seconds of clean
// speech: the same person in two meetings was never below 0.71, and two
// different people were never above 0.50, in one meeting or across them.
/// Below this, two voices are different people.
let differentPeople: Float = 0.5
/// At or above this, two voices are one person.
let samePerson: Float = 0.75
/// Voices with less clean speech than this are not compared.
let comparableSeconds = 10.0

/// community-1 sometimes splits one person in two. Put back together the
/// speakers whose voices are plainly one person.
func mergeSameVoices(_ spans: [Span], _ voices: [String: Voice]) -> [Span] {
    let comparable = voices.filter { $0.value.seconds >= comparableSeconds }.keys.sorted { speech(spans, of: $0) > speech(spans, of: $1) }
    var into: [String: String] = [:]
    for (index, speaker) in comparable.enumerated() {
        // The speaker with the most speech keeps its identity.
        if let larger = comparable[..<index].first(where: { into[$0] == nil && similarity(voices[$0]!, voices[speaker]!) >= samePerson }) {
            into[speaker] = larger
        }
    }
    return spans.map { Span(start: $0.start, end: $0.end, speaker: into[$0.speaker] ?? $0.speaker) }
}

/// Whether one Nemotron 3 voice holds two community-1 voices that are plainly
/// different people: Nemotron 3 merged them.
func mergesDifferentPeople(_ nemotron: [Span], _ checked: [Span], _ voices: [String: Voice]) -> Bool {
    var home: [String: String] = [:]
    for speaker in Set(checked.map(\.speaker)) {
        let own = checked.filter { $0.speaker == speaker }
        var shared: [String: Double] = [:]
        for span in own {
            for other in nemotron where other.start < span.end && other.end > span.start {
                shared[other.speaker, default: 0] += min(span.end, other.end) - max(span.start, other.start)
            }
        }
        home[speaker] = shared.max { $0.value < $1.value }?.key
    }
    // A few seconds of speech can be a cough or a crossed line, not a person.
    let people = voices.filter { $0.value.seconds >= comparableSeconds && speech(checked, of: $0.key) >= 20 }.keys.sorted()
    for (index, left) in people.enumerated() {
        for right in people[(index + 1)...] where home[left] != nil && home[left] == home[right] {
            if similarity(voices[left]!, voices[right]!) < differentPeople { return true }
        }
    }
    return false
}

/// One channel's speakers and the model that found them.
///
/// auto runs both. On those AMI meetings Nemotron 3 put the wrong speaker on
/// 0.55% of words outside crosstalk against 2.98% for community-1 (0.56% and
/// 2.96% through Opus). On Tyler's calls, though, it twice heard two people as
/// one where community-1 kept them apart, and their voices were plainly
/// different (similarity 0.18 and 0.36). A merge can't be fixed by naming, so
/// community-1, its speakers' voices compared, has the last word: Nemotron 3's
/// answer is kept unless it put two plainly different voices together, filled
/// every slot, or found more voices than the caller's ceiling.
func choose(_ samples: [Float]) async throws -> (spans: [Span], model: String) {
    switch engine {
    case .community1:
        return (try await community1(samples), modelName)
    case .nemotron3:
        guard let nemotron else { return (try await community1(samples), modelName) }
        let spans = try nemotron3(samples, nemotron)
        // Every slot taken means the call may have more people than the model
        // can hold, and they would be merged. community-1 has no cap.
        if Set(spans.map(\.speaker)).count >= nemotronConfig.numSpeakers, modelsReady(root) {
            note("All eight speaker slots are in use; using community-1 for this channel.")
            return (try await community1(samples), modelName)
        }
        if let voiceLimit, Set(spans.map(\.speaker)).count > voiceLimit, modelsReady(root) {
            note("Nemotron 3 heard more voices than the meeting has people; using community-1 for this channel.")
            return (try await community1(samples), modelName)
        }
        return (spans, nemotronModelName)
    case .auto:
        let checked = try await community1(samples)
        let checkedVoices = await embedVoices(samples, checked)
        let fallback = (mergeSameVoices(checked, checkedVoices), modelName)
        guard let nemotron else { return fallback }
        // community-1 has already answered: a Nemotron 3 failure must not throw that away.
        let spans: [Span]
        do { spans = try nemotron3(samples, nemotron) } catch {
            note("Nemotron 3 failed on this channel (\(error.localizedDescription)); using community-1.")
            return fallback
        }
        let found = Set(spans.map(\.speaker)).count
        if found >= nemotronConfig.numSpeakers {
            note("All eight speaker slots are in use; using community-1 for this channel.")
            return fallback
        }
        if let voiceLimit, found > voiceLimit {
            note("Nemotron 3 heard more voices than the meeting has people; using community-1 for this channel.")
            return fallback
        }
        if mergesDifferentPeople(spans, checked, checkedVoices) {
            note("Nemotron 3 heard two different voices as one; using community-1 for this channel.")
            return fallback
        }
        return (spans, nemotronModelName)
    }
}

func separate(_ samples: [Float], role: String?) async throws {
    let (spans, model) = try await choose(samples)
    if !usedModels.contains(model) { usedModels.append(model) }
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
    for (speaker, voice) in await embedVoices(samples, spans) {
        guard let id = identities[speaker] else { continue }
        voices[id] = ["embedding": voice.embedding.map { (Double($0) * 10_000).rounded() / 10_000 }, "seconds": round3(voice.seconds)]
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
    "model": usedModels.isEmpty ? (useNemotron ? nemotronModelName : modelName) : usedModels.joined(separator: " and "),
    "device": "ane",
    "channels": audio.count,
    "turns": coalesce(turns).map { turn -> [String: Any] in
        var value: [String: Any] = ["start": turn.start, "end": turn.end, "speaker": turn.speaker]
        if let role = turn.role { value["role"] = role }
        return value
    },
    "speakers": speakers.keys.sorted().map { ["id": $0, "label": speakers[$0]!] },
    "voices": voices,
])
