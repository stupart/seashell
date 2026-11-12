import AppKit
import CoreAudio
import Foundation

private struct InputProcess: Codable {
    let pid: Int32
    let bundleId: String
    let name: String
}

private struct SignalSnapshot: Codable {
    let schemaVersion: Int
    let capturedAtUnixMs: Int64
    let supported: Bool
    /// False when Core Audio did not answer for every process, as on an
    /// overloaded Mac: a process missing from the list may still hold its
    /// microphone, so its absence proves nothing.
    let complete: Bool
    let frontmostBundleId: String?
    let inputProcesses: [InputProcess]
}

private func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

private func uint32Property(
    _ objectID: AudioObjectID,
    selector: AudioObjectPropertySelector
) -> UInt32? {
    var address = propertyAddress(selector)
    var dataSize = UInt32(MemoryLayout<UInt32>.size)
    var value: UInt32 = 0
    guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &dataSize, &value) == noErr else {
        return nil
    }
    return value
}

private func int32Property(
    _ objectID: AudioObjectID,
    selector: AudioObjectPropertySelector
) -> Int32? {
    var address = propertyAddress(selector)
    var dataSize = UInt32(MemoryLayout<Int32>.size)
    var value: Int32 = 0
    guard AudioObjectGetPropertyData(objectID, &address, 0, nil, &dataSize, &value) == noErr else {
        return nil
    }
    return value
}

private func stringProperty(
    _ objectID: AudioObjectID,
    selector: AudioObjectPropertySelector
) -> String? {
    var address = propertyAddress(selector)
    var dataSize = UInt32(MemoryLayout<CFString?>.size)
    var value: CFString?
    let status = withUnsafeMutablePointer(to: &value) { pointer in
        AudioObjectGetPropertyData(objectID, &address, 0, nil, &dataSize, pointer)
    }
    guard status == noErr, let value else { return nil }
    return value as String
}

private func audioInputProcesses() -> (processes: [InputProcess], complete: Bool) {
    guard #available(macOS 14.2, *) else { return ([], true) }
    var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
    var dataSize: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &dataSize) == noErr else {
        return ([], false)
    }
    guard dataSize > 0 else { return ([], true) }
    var ids = [AudioObjectID](
        repeating: 0,
        count: Int(dataSize) / MemoryLayout<AudioObjectID>.size
    )
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &dataSize, &ids) == noErr else {
        return ([], false)
    }
    var complete = true
    let processes = ids.compactMap { objectID -> InputProcess? in
        // A process that exits between the list and this read also lands
        // here; that costs one poll its evidence, never a recording.
        guard let running = uint32Property(objectID, selector: kAudioProcessPropertyIsRunningInput) else {
            complete = false
            return nil
        }
        guard running != 0 else { return nil }
        guard let pid = int32Property(objectID, selector: kAudioProcessPropertyPID), pid >= 0 else {
            complete = false
            return nil
        }
        guard let bundleId = stringProperty(objectID, selector: kAudioProcessPropertyBundleID),
              !bundleId.isEmpty else {
            return nil
        }
        let application = NSRunningApplication(processIdentifier: pid_t(pid))
        return InputProcess(
            pid: pid,
            bundleId: bundleId,
            name: application?.localizedName ?? ""
        )
    }
    return (processes, complete)
}

private func currentSnapshot() -> SignalSnapshot {
    let supported: Bool
    if #available(macOS 14.2, *) {
        supported = true
    } else {
        supported = false
    }
    let input = audioInputProcesses()
    return SignalSnapshot(
        schemaVersion: 1,
        capturedAtUnixMs: Int64(Date().timeIntervalSince1970 * 1_000),
        supported: supported,
        complete: input.complete,
        frontmostBundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
        inputProcesses: input.processes
    )
}

private func writeSnapshot(_ encoder: JSONEncoder) {
    do {
        let data = try encoder.encode(currentSnapshot())
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        FileHandle.standardError.write(Data("Could not encode meeting signals: \(error)\n".utf8))
        exit(1)
    }
}

private let arguments = Array(CommandLine.arguments.dropFirst())
private let watch = arguments.contains("--watch")
private let intervalMilliseconds: UInt64 = {
    guard let flag = arguments.firstIndex(of: "--interval-ms"),
          arguments.indices.contains(flag + 1),
          let value = UInt64(arguments[flag + 1]),
          value >= 250 else {
        return 3_000
    }
    return min(value, 60_000)
}()
private let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]

repeat {
    writeSnapshot(encoder)
    if watch {
        Thread.sleep(forTimeInterval: Double(intervalMilliseconds) / 1_000)
    }
} while watch
