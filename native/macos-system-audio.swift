// Adapted from OpenWhispr's MIT-licensed macos-audio-tap.swift.
// Copyright (c) 2024 OpenWhispr Team. See THIRD_PARTY_NOTICES.md.

import AVFoundation
import AudioToolbox
import CoreAudio
import Darwin
import Foundation

@available(macOS 14.2, *)
struct CaptureConfig {
    let sampleRate: Double
    let chunkMilliseconds: Int
    let probeMilliseconds: Int?
}

@available(macOS 14.2, *)
final class SystemAudioCapture {
    private let config: CaptureConfig
    private let targetFormat: AVAudioFormat
    private let outputChunkBytes: Int
    private let ioQueue = DispatchQueue(label: "com.seashell.system-audio")
    private var tapID: AudioObjectID = 0
    private var aggregateDeviceID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var pendingPCM = Data()
    private var firstBufferSeen = false
    private var stopping = false

    init(config: CaptureConfig) {
        self.config = config
        self.targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: config.sampleRate,
            channels: 1,
            interleaved: true
        )!
        let frames = Int(config.sampleRate * Double(config.chunkMilliseconds) / 1_000.0)
        self.outputChunkBytes = max(2, frames * 2)
    }

    func start() throws {
        let tapDescription = CATapDescription()
        tapDescription.name = "Sea Shell System Audio"
        tapDescription.uuid = UUID()
        tapDescription.processes = []
        tapDescription.isMono = true
        tapDescription.isExclusive = true
        tapDescription.isMixdown = true
        tapDescription.isPrivate = true
        tapDescription.muteBehavior = .unmuted

        var newTapID = AudioObjectID()
        var status = AudioHardwareCreateProcessTap(tapDescription, &newTapID)
        guard status == noErr else {
            throw captureError("Could not create the system-audio tap", status, "create_process_tap")
        }
        tapID = newTapID

        let tapUID = try readTapUID()
        try createAggregateDevice(tapUID: tapUID)
        try waitForAggregateDevice()
        try configureConverter()
        try registerIOProc()

        ioQueue.suspend()
        status = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard status == noErr else {
            ioQueue.resume()
            throw captureError("Could not start system-audio capture", status, "start_device")
        }
        emit([
            "type": "start",
            "sampleRate": Int(config.sampleRate),
            "channels": 1,
            "bitsPerChannel": 16,
        ])
        ioQueue.resume()
    }

    func stop() {
        if stopping { return }
        stopping = true
        if aggregateDeviceID != 0 {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
        }
        if let ioProcID {
            AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
            self.ioProcID = nil
        }
        if aggregateDeviceID != 0 {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = 0
        }
        if tapID != 0 {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = 0
        }
        if config.probeMilliseconds == nil { flushPendingPCM() }
        emit(["type": "stop"])
    }

    private func createAggregateDevice(tapUID: String) throws {
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Sea Shell System Audio",
            kAudioAggregateDeviceUIDKey: "com.seashell.system-audio.\(UUID().uuidString)",
            kAudioAggregateDeviceSubDeviceListKey: [],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID]],
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
        ]
        var deviceID = AudioObjectID()
        let status = AudioHardwareCreateAggregateDevice(description as CFDictionary, &deviceID)
        guard status == noErr else {
            throw captureError("Could not create the private aggregate device", status, "create_aggregate_device")
        }
        aggregateDeviceID = deviceID
    }

    private func waitForAggregateDevice() throws {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        for _ in 0..<20 {
            var alive: UInt32 = 0
            var size = UInt32(MemoryLayout<UInt32>.size)
            let status = AudioObjectGetPropertyData(
                aggregateDeviceID,
                &address,
                0,
                nil,
                &size,
                &alive
            )
            if status == noErr && alive != 0 { return }
            Thread.sleep(forTimeInterval: 0.1)
        }
        throw captureError("System-audio device did not become ready", nil, "wait_for_device")
    }

    private func configureConverter() throws {
        var stream = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &stream)
        guard status == noErr else {
            throw captureError("Could not read the system-audio format", status, "get_tap_format")
        }
        guard let sourceFormat = AVAudioFormat(streamDescription: &stream) else {
            throw captureError("Could not interpret the system-audio format", nil, "source_format")
        }
        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw captureError("Could not create the system-audio converter", nil, "create_converter")
        }
        self.sourceFormat = sourceFormat
        self.converter = converter
    }

    private func registerIOProc() throws {
        guard let sourceFormat, let converter else {
            throw captureError("System-audio converter is unavailable", nil, "register_ioproc")
        }
        var processID: AudioDeviceIOProcID?
        let status = AudioDeviceCreateIOProcIDWithBlock(
            &processID,
            aggregateDeviceID,
            ioQueue
        ) { [weak self] _, inputData, inputTime, _, _ in
            guard let self, !self.stopping else { return }
            self.consume(
                inputData,
                inputTime: inputTime.pointee,
                sourceFormat: sourceFormat,
                converter: converter
            )
        }
        guard status == noErr, let processID else {
            throw captureError("Could not register the system-audio callback", status, "create_ioproc")
        }
        ioProcID = processID
    }

    private func consume(
        _ inputData: UnsafePointer<AudioBufferList>,
        inputTime: AudioTimeStamp,
        sourceFormat: AVAudioFormat,
        converter: AVAudioConverter
    ) {
        if !firstBufferSeen {
            firstBufferSeen = true
            var event: [String: Any] = [
                "type": "first-buffer",
                "capturedAtUnixMs": Int(Date().timeIntervalSince1970 * 1_000),
            ]
            if inputTime.mFlags.contains(.hostTimeValid) {
                event["hostTime"] = String(inputTime.mHostTime)
            }
            if inputTime.mFlags.contains(.sampleTimeValid) {
                event["sampleTime"] = inputTime.mSampleTime
            }
            emit(event)
        }
        if config.probeMilliseconds != nil { return }

        let inputList = UnsafeMutablePointer(mutating: inputData)
        guard let sourceBuffer = AVAudioPCMBuffer(
            pcmFormat: sourceFormat,
            bufferListNoCopy: inputList,
            deallocator: nil
        ) else { return }

        let sourceRate = max(sourceFormat.sampleRate, 1)
        let capacity = AVAudioFrameCount(
            ceil(Double(sourceBuffer.frameLength) * targetFormat.sampleRate / sourceRate)
        ) + 32
        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: targetFormat,
            frameCapacity: max(capacity, 32)
        ) else { return }

        var providedInput = false
        var conversionError: NSError?
        let conversionStatus = converter.convert(to: outputBuffer, error: &conversionError) {
            _, outputStatus in
            if providedInput {
                outputStatus.pointee = .noDataNow
                return nil
            }
            providedInput = true
            outputStatus.pointee = .haveData
            return sourceBuffer
        }
        if let conversionError {
            emit([
                "type": "error",
                "code": "convert_failed",
                "message": conversionError.localizedDescription,
            ])
            return
        }
        guard conversionStatus == .haveData || conversionStatus == .inputRanDry else { return }

        let audio = outputBuffer.audioBufferList.pointee.mBuffers
        guard let data = audio.mData, audio.mDataByteSize > 0 else { return }
        pendingPCM.append(data.assumingMemoryBound(to: UInt8.self), count: Int(audio.mDataByteSize))
        flushFullChunks()
    }

    private func flushFullChunks() {
        while pendingPCM.count >= outputChunkBytes {
            let chunk = pendingPCM.prefix(outputChunkBytes)
            chunk.withUnsafeBytes { bytes in
                guard let base = bytes.baseAddress else { return }
                writeAll(STDOUT_FILENO, base, bytes.count)
            }
            pendingPCM.removeFirst(outputChunkBytes)
        }
    }

    private func flushPendingPCM() {
        guard !pendingPCM.isEmpty else { return }
        pendingPCM.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            writeAll(STDOUT_FILENO, base, bytes.count)
        }
        pendingPCM.removeAll(keepingCapacity: false)
    }

    private func readTapUID() throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var unmanagedUID: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &unmanagedUID) { pointer in
            AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, pointer)
        }
        guard status == noErr, let unmanagedUID else {
            throw captureError("Could not read the system-audio tap identity", status, "get_tap_uid")
        }
        return unmanagedUID.takeRetainedValue() as String
    }
}

@available(macOS 14.2, *)
func parseConfig() -> CaptureConfig {
    var sampleRate = 16_000.0
    var chunkMilliseconds = 100
    var probeMilliseconds: Int?
    let arguments = Array(CommandLine.arguments.dropFirst())
    var index = 0
    while index < arguments.count {
        let name = arguments[index]
        switch name {
        case "--sample-rate":
            if index + 1 < arguments.count,
               let value = Double(arguments[index + 1]), value > 0 {
                sampleRate = value
            }
            index += 2
        case "--chunk-ms":
            if index + 1 < arguments.count,
               let value = Int(arguments[index + 1]), value > 0 {
                chunkMilliseconds = value
            }
            index += 2
        case "--probe-ms":
            if index + 1 < arguments.count,
               let value = Int(arguments[index + 1]), value > 0 {
                probeMilliseconds = value
            }
            index += 2
        default:
            index += 1
        }
    }
    return CaptureConfig(
        sampleRate: sampleRate,
        chunkMilliseconds: chunkMilliseconds,
        probeMilliseconds: probeMilliseconds
    )
}

func emit(_ event: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(event),
          let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    FileHandle.standardError.write(data)
    FileHandle.standardError.write(Data([0x0a]))
}

func writeAll(_ fileDescriptor: Int32, _ buffer: UnsafeRawPointer, _ count: Int) {
    var written = 0
    while written < count {
        let result = Darwin.write(fileDescriptor, buffer.advanced(by: written), count - written)
        if result <= 0 { return }
        written += result
    }
}

func captureError(
    _ message: String,
    _ status: OSStatus?,
    _ operation: String
) -> NSError {
    let permissionDenied = status == kAudioHardwareIllegalOperationError
    var details: [String: Any] = [
        NSLocalizedDescriptionKey: message,
        "CaptureErrorCode": permissionDenied ? "permission_denied" : operation,
        "CaptureOperation": operation,
    ]
    if let status { details["CaptureStatus"] = Int(status) }
    return NSError(domain: "SeaShellSystemAudio", code: Int(status ?? -1), userInfo: details)
}

if #available(macOS 14.2, *) {
    let config = parseConfig()
    let capture = SystemAudioCapture(config: config)
    var signalSources: [DispatchSourceSignal] = []

    func stopAndExit(_ code: Int32) -> Never {
        capture.stop()
        exit(code)
    }

    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    for signalValue in [SIGINT, SIGTERM] {
        let source = DispatchSource.makeSignalSource(signal: signalValue, queue: .main)
        source.setEventHandler { stopAndExit(0) }
        source.resume()
        signalSources.append(source)
    }

    do {
        try capture.start()
        if let probeMilliseconds = config.probeMilliseconds {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(probeMilliseconds)) {
                stopAndExit(0)
            }
        }
        dispatchMain()
    } catch {
        let failure = error as NSError
        emit([
            "type": "error",
            "code": failure.userInfo["CaptureErrorCode"] as? String ?? "start_failed",
            "message": failure.localizedDescription,
            "operation": failure.userInfo["CaptureOperation"] as? String ?? "start",
            "status": failure.userInfo["CaptureStatus"] as? Int ?? failure.code,
        ])
        capture.stop()
        exit(1)
    }
} else {
    emit([
        "type": "error",
        "code": "unsupported_os",
        "message": "Live system-audio capture requires macOS 14.2 or later",
    ])
    exit(1)
}
