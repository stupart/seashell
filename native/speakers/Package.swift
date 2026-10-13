// swift-tools-version: 6.2
import Foundation
import PackageDescription

// FluidAudio runs pyannote's community-1 speaker models on the Neural Engine.
// Homebrew builds offline from the source tarball it stages and names in
// SEASHELL_FLUIDAUDIO_PATH; a checkout fetches the same pinned release.
// `traits: []` leaves out its text-normalization binary, which diarization
// does not use.
let fluidAudio: Package.Dependency = {
    if let path = ProcessInfo.processInfo.environment["SEASHELL_FLUIDAUDIO_PATH"], !path.isEmpty {
        return .package(path: path, traits: [])
    }
    return .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7", traits: [])
}()

let package = Package(
    name: "SeashellSpeakers",
    platforms: [.macOS(.v14)],
    dependencies: [fluidAudio],
    targets: [
        .executableTarget(
            name: "SeashellSpeakers",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources/SeashellSpeakers"
        ),
    ],
    // A short-lived command-line tool with no concurrency of its own.
    swiftLanguageModes: [.v5]
)
