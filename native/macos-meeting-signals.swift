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

private func audioInputProcesses() -> [InputProcess] {
    guard #available(macOS 14.2, *) else { return [] }
    var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
    var dataSize: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &dataSize) == noErr,
          dataSize > 0 else {
        return []
    }
    var ids = [AudioObjectID](
        repeating: 0,
        count: Int(dataSize) / MemoryLayout<AudioObjectID>.size
    )
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &dataSize, &ids) == noErr else {
        return []
    }
    return ids.compactMap { objectID in
        guard (uint32Property(objectID, selector: kAudioProcessPropertyIsRunningInput) ?? 0) != 0,
              let bundleId = stringProperty(objectID, selector: kAudioProcessPropertyBundleID),
              !bundleId.isEmpty,
              let pid = int32Property(objectID, selector: kAudioProcessPropertyPID),
              pid >= 0 else {
            return nil
        }
        let application = NSRunningApplication(processIdentifier: pid_t(pid))
        return InputProcess(
            pid: pid,
            bundleId: bundleId,
            name: application?.localizedName ?? ""
        )
    }
}

private let supported: Bool
if #available(macOS 14.2, *) {
    supported = true
} else {
    supported = false
}
private let snapshot = SignalSnapshot(
    schemaVersion: 1,
    capturedAtUnixMs: Int64(Date().timeIntervalSince1970 * 1_000),
    supported: supported,
    frontmostBundleId: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
    inputProcesses: audioInputProcesses()
)
private let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
do {
    let data = try encoder.encode(snapshot)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0A]))
} catch {
    FileHandle.standardError.write(Data("Could not encode meeting signals: \(error)\n".utf8))
    exit(1)
}
