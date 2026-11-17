// Adapted from OpenWhispr's MIT-licensed macos-audio-tap.swift.
// Copyright (c) 2024 OpenWhispr Team. See THIRD_PARTY_NOTICES.md.
//
// Seashell's computer-audio recorder. Like seashell-microphone, it relaunches
// itself as its own responsible process, so macOS asks once for, and
// remembers, this executable's System Audio Recording permission. The
// background recorder and the guided setup's test in a terminal then use one
// identity: a test that passes means meetings hear the others too.
//
// Nothing it does can hold up the device. The IO block runs on the device's IO
// thread with no dispatch queue and only copies each packet into a
// preallocated lock-free ring (seashell-audio-ring.c). A consumer queue
// converts and writes stdout without ever waiting for the reader: what cannot
// keep up is dropped, replaced by silence of the same length, and marked.
// `--handoff-check` proves both on synthetic packets, without a device.
//
// Protocol 2 (SeashellHelperProtocol in macos-system-audio-Info.plist):
// - stdout: signed 16-bit little-endian mono PCM at --sample-rate.
// - stderr: one JSON event per line: start, first-buffer, discontinuity,
//   paused, resumed, warning, error, stop.
// - discontinuity {droppedFrames, outputFrames, reason: "capture-overrun",
//   stage}: the stream already holds droppedFrames of silence at frame
//   outputFrames. stage "capture": the consumer fell behind the IO thread;
//   "output": stdout's reader fell behind.
// - Pause: SIGUSR1 to the helper's process group stops the device's IO and
//   keeps the tap and the aggregate. Answer: {"type":"paused","outputFrames":N}.
//   Resume: SIGUSR2. Answer: {"type":"resumed","outputFrames":N}, then, with
//   the next audio, a first-buffer event whose outputFrames is N and whose
//   clock evidence is new. Every frame before N was captured before the pause.
//   Every request is answered, even one that changes nothing; send the next
//   only after the answer, and none before the start event. A failure is an
//   error event (pause_failed, resume_failed) and exit 1, and a route change
//   ends a paused helper as it ends a running one. A paused helper writes no
//   PCM, so a watchdog on stdout must not run while it is paused.
//   Protocol 1 helpers die of SIGUSR1: check the protocol first.

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

/** Seconds of tap audio the IO thread can hand over while the consumer is held up. */
private let ringSeconds = 6.0
/** Seconds of converted audio kept for a reader that is away, as Bun is under load. */
private let pipeSeconds = 30.0
/** How often the consumer looks for audio. The IO thread never wakes it: a
 * semaphore signal can be a system call, and the ring holds seconds anyway. */
private let consumerInterval = DispatchTimeInterval.milliseconds(10)
/** While paused, only the backlog for a slow reader is left to write. */
private let pausedConsumerInterval = DispatchTimeInterval.milliseconds(250)
/** How long a stop waits for the reader to take what is left. */
private let finalDrainMilliseconds: Int32 = 750

/**
 * Everything after the IO thread: conversion to the capture format, gaps, and
 * stdout. The IO block (seashell-audio-ring.c) only copies packets into the
 * ring; this reads them on one queue, converts them, and queues the result on
 * a pipe that never waits for its reader. Whatever cannot keep up is dropped
 * and replaced by silence of the same length, and a discontinuity says where.
 */
@available(macOS 14.2, *)
final class SystemAudioStream {
    let ring: OpaquePointer
    private let pipe: OpaquePointer
    private let sourceFormat: AVAudioFormat
    private let targetFormat: AVAudioFormat
    private let converter: AVAudioConverter
    private let chunkBytes: Int
    private let probe: Bool
    private let emit: ([String: Any]) -> Void
    private var scratch: AVAudioPCMBuffer
    private var pendingPCM = Data()
    /** Where in the stream the first byte of pendingPCM lands. */
    private var pendingStart: UInt64 = 0
    private var firstBufferSeen = false
    /** Frames in the stream so far, silence included: where the next frame lands. */
    private(set) var outputFrames: UInt64 = 0
    /** Audio stdout could not take, said once that stretch ends. */
    private var outputGap: (start: UInt64, frames: UInt64)?
    private(set) var readerGone = false
    var onReaderGone: (() -> Void)?

    init?(
        sourceFormat: AVAudioFormat,
        targetFormat: AVAudioFormat,
        chunkMilliseconds: Int,
        probe: Bool,
        output: Int32 = STDOUT_FILENO,
        outputSeconds: Double = pipeSeconds,
        emit: @escaping ([String: Any]) -> Void
    ) {
        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat),
              let scratch = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: 16_384),
              let ring = seashell_audio_ring_create(sourceFormat.streamDescription, ringSeconds, 32 << 20) else { return nil }
        let bytesPerSecond = Int(targetFormat.sampleRate) * Int(targetFormat.streamDescription.pointee.mBytesPerFrame)
        guard let pipe = seashell_pcm_pipe_create(output, max(Int(outputSeconds * Double(bytesPerSecond)), 2)) else {
            seashell_audio_ring_destroy(ring)
            return nil
        }
        let frames = Int(targetFormat.sampleRate * Double(chunkMilliseconds) / 1_000.0)
        self.ring = ring
        self.pipe = pipe
        self.sourceFormat = sourceFormat
        self.targetFormat = targetFormat
        self.converter = converter
        self.scratch = scratch
        self.chunkBytes = max(2, frames * 2)
        self.probe = probe
        self.emit = emit
    }

    deinit {
        seashell_audio_ring_destroy(ring)
        seashell_pcm_pipe_destroy(pipe)
    }

    /** Converts every packet the IO thread has handed over and writes what the reader takes now. */
    func drain() {
        var record = seashell_audio_record()
        while seashell_audio_ring_peek(ring, &record) {
            if record.droppedFramesBefore > 0 { appendCaptureGap(droppedSourceFrames: record.droppedFramesBefore) }
            if record.frames > scratch.frameCapacity,
               let larger = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: record.frames) {
                scratch = larger
            }
            scratch.frameLength = min(record.frames, scratch.frameCapacity)
            guard seashell_audio_ring_read(ring, &record, scratch.mutableAudioBufferList) else {
                appendCaptureGap(droppedSourceFrames: UInt64(record.frames))
                continue
            }
            var time = AudioTimeStamp()
            time.mHostTime = record.hostTime
            time.mSampleTime = record.sampleTime
            time.mFlags = AudioTimeStampFlags(rawValue: record.timeFlags)
            consume(scratch, inputTime: time)
        }
        flush()
    }

    /** The IO thread has stopped: everything it captured goes out, and the
     * stream's length says where the pause or stop falls. */
    @discardableResult
    func settle() -> UInt64 {
        drain()
        let trailing = seashell_audio_ring_take_trailing_drops(ring)
        if trailing > 0 { appendCaptureGap(droppedSourceFrames: trailing) }
        if !probe {
            flushConverter()
            submitPending()
        }
        closeOutputGap()
        flush()
        return outputFrames
    }

    /** After a pause, the next packet is a first buffer again: its own clock evidence. */
    func restartTiming() {
        firstBufferSeen = false
    }

    /** Settles, then waits at most timeoutMs for the reader to take it all. */
    func finish(timeoutMs: Int32) {
        settle()
        deliver(timeoutMs: timeoutMs)
    }

    /** Waits at most timeoutMs for the reader to take everything queued. */
    @discardableResult
    func deliver(timeoutMs: Int32) -> Bool {
        guard !probe, !readerGone else { return false }
        let result = seashell_pcm_pipe_drain(pipe, timeoutMs)
        if result < 0 { lostReader() }
        return result == 0
    }

    private func flush() {
        guard !probe, !readerGone else { return }
        if seashell_pcm_pipe_flush(pipe) < 0 { lostReader() }
    }

    private func lostReader() {
        guard !readerGone else { return }
        readerGone = true
        onReaderGone?()
    }

    /** Frames the IO thread could not hand over, as silence where they belonged. */
    private func appendCaptureGap(droppedSourceFrames: UInt64) {
        let frames = UInt64((Double(droppedSourceFrames) * targetFormat.sampleRate /
            max(sourceFormat.sampleRate, 1)).rounded())
        guard frames > 0 else { return }
        if !probe { submitPending() }
        emit([
            "type": "discontinuity",
            "reason": "capture-overrun",
            "stage": "capture",
            "droppedFrames": Int(frames),
            "outputFrames": Int(outputFrames),
        ])
        if !probe { seashell_pcm_pipe_append_zeros(pipe, frames * 2) }
        outputFrames += frames
        pendingStart = outputFrames
    }

    private func closeOutputGap() {
        guard let gap = outputGap else { return }
        outputGap = nil
        emit([
            "type": "discontinuity",
            "reason": "capture-overrun",
            "stage": "output",
            "droppedFrames": Int(gap.frames),
            "outputFrames": Int(gap.start),
        ])
    }

    private func submit(_ bytes: UnsafeRawBufferPointer) {
        guard let base = bytes.baseAddress, bytes.count > 0 else { return }
        let start = pendingStart
        let frames = UInt64(bytes.count / 2)
        pendingStart += frames
        if seashell_pcm_pipe_append(pipe, base, bytes.count) == 0 {
            closeOutputGap()
        } else if let gap = outputGap, gap.start + gap.frames == start {
            outputGap = (gap.start, gap.frames + frames)
        } else {
            closeOutputGap()
            outputGap = (start, frames)
        }
    }

    private func submitPending() {
        guard !pendingPCM.isEmpty else { return }
        pendingPCM.withUnsafeBytes { submit($0) }
        pendingPCM.removeAll(keepingCapacity: true)
    }

    private func flushFullChunks() {
        guard pendingPCM.count >= chunkBytes else { return }
        var offset = 0
        pendingPCM.withUnsafeBytes { bytes in
            while bytes.count - offset >= chunkBytes {
                submit(UnsafeRawBufferPointer(rebasing: bytes[offset..<(offset + chunkBytes)]))
                offset += chunkBytes
            }
        }
        pendingPCM.removeFirst(offset)
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        let audio = buffer.audioBufferList.pointee.mBuffers
        guard let data = audio.mData, audio.mDataByteSize > 0 else { return }
        pendingPCM.append(data.assumingMemoryBound(to: UInt8.self), count: Int(audio.mDataByteSize))
        outputFrames += UInt64(audio.mDataByteSize / 2)
        flushFullChunks()
    }

    /** What the converter still holds from before a pause or stop: it belongs before it. */
    private func flushConverter() {
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: 4_096) else { return }
        var conversionError: NSError?
        let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outputStatus in
            outputStatus.pointee = .endOfStream
            return nil
        }
        if conversionError == nil, status != .error { append(outputBuffer) }
        converter.reset()
    }

    private func consume(_ sourceBuffer: AVAudioPCMBuffer, inputTime: AudioTimeStamp) {
        if !firstBufferSeen {
            firstBufferSeen = true
            let observedAtUnixMs = Int(Date().timeIntervalSince1970 * 1_000)
            let bufferDurationMs = Double(sourceBuffer.frameLength) * 1_000 /
                max(sourceFormat.sampleRate, 1)
            var bufferStartUnixMs = observedAtUnixMs - Int(round(bufferDurationMs))
            if inputTime.mFlags.contains(.hostTimeValid) {
                let currentHostTime = AudioGetCurrentHostTime()
                if currentHostTime >= inputTime.mHostTime {
                    let elapsedNanos = AudioConvertHostTimeToNanos(
                        currentHostTime - inputTime.mHostTime
                    )
                    bufferStartUnixMs = observedAtUnixMs - Int(elapsedNanos / 1_000_000)
                }
            }
            var event: [String: Any] = [
                "type": "first-buffer",
                "capturedAtUnixMs": observedAtUnixMs,
                "bufferStartUnixMs": bufferStartUnixMs,
                "sourceSampleRate": Int(sourceFormat.sampleRate),
                // Where this buffer's audio starts in the stream: 0, or the frame a resume picks up at.
                "outputFrames": Int(outputFrames),
            ]
            if inputTime.mFlags.contains(.hostTimeValid) {
                event["hostTime"] = String(inputTime.mHostTime)
            }
            if inputTime.mFlags.contains(.sampleTimeValid) {
                event["sampleTime"] = inputTime.mSampleTime
            }
            event["bufferFrames"] = Int(sourceBuffer.frameLength)
            emit(event)
        }
        if probe { return }

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
        append(outputBuffer)
    }
}

@available(macOS 14.2, *)
final class SystemAudioCapture {
    private let config: CaptureConfig
    private let targetFormat: AVAudioFormat
    // The IO block has no queue: it runs on the device's IO thread itself
    // (seashell_audio_ring_create_ioproc). Conversion and stdout run here, below
    // that thread and above everything else this helper does.
    private let consumerQueue = DispatchQueue(label: "com.seashell.system-audio.consumer", qos: .userInitiated)
    private var tapID: AudioObjectID = 0
    private var aggregateDeviceID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?
    private var sourceFormat: AVAudioFormat?
    private var stream: SystemAudioStream?
    private var consumerTimer: DispatchSourceTimer?
    private var stopping = false
    private var paused = false
    private var routeListeners: [(AudioObjectID, AudioObjectPropertyAddress, AudioObjectPropertyListenerBlock)] = []
    var onDeviceChanged: (() -> Void)?
    /** The reader closed stdout: capture is over. Called on the main queue. */
    var onReaderGone: (() -> Void)?
    /** Pausing or resuming failed; the helper cannot say which state it is in. Called on the main queue. */
    var onPauseFailed: (() -> Void)?

    init(config: CaptureConfig) {
        self.config = config
        self.targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: config.sampleRate,
            channels: 1,
            interleaved: true
        )!
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
        let clockDeviceUID = try readDefaultSystemOutputUID()
        try createAggregateDevice(tapUID: tapUID, clockDeviceUID: clockDeviceUID)
        try waitForAggregateDevice()
        try readSourceFormat()
        if config.probeMilliseconds == nil { observeAudioRoute() }
        guard let sourceFormat else {
            throw captureError("System-audio source format is unavailable", nil, "source_format")
        }
        guard let stream = SystemAudioStream(
            sourceFormat: sourceFormat,
            targetFormat: targetFormat,
            chunkMilliseconds: config.chunkMilliseconds,
            probe: config.probeMilliseconds != nil,
            emit: emit
        ) else {
            throw captureError("Could not prepare the system-audio handoff", nil, "create_converter")
        }
        stream.onReaderGone = { [weak self] in
            DispatchQueue.main.async { self?.onReaderGone?() }
        }
        self.stream = stream
        startConsumer()
        try registerIOProc()

        status = AudioDeviceStart(aggregateDeviceID, ioProcID)
        guard status == noErr else {
            throw captureError("Could not start system-audio capture", status, "start_device")
        }
        emit([
            "type": "start",
            "sampleRate": Int(config.sampleRate),
            "channels": 1,
            "bitsPerChannel": 16,
        ])
    }

    func stop() {
        if stopping { return }
        stopping = true
        for (object, var address, block) in routeListeners {
            AudioObjectRemovePropertyListenerBlock(object, &address, .main, block)
        }
        routeListeners.removeAll()
        // The ring belongs to the stream, which lives as long as this capture:
        // however the HAL schedules the IO block's last call, it copies into
        // memory that is still ours.
        if aggregateDeviceID != 0 {
            AudioDeviceStop(aggregateDeviceID, ioProcID)
        }
        consumerTimer?.cancel()
        consumerTimer = nil
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
        if let stream {
            consumerQueue.sync { stream.finish(timeoutMs: finalDrainMilliseconds) }
        }
        emit(["type": "stop"])
    }

    /**
     * Stops the device's IO for this helper, keeping the tap and the private
     * aggregate, so a resume costs no teardown and no new device. The stream's
     * length when it took effect follows in the acknowledgement: every frame
     * before `outputFrames` was captured before the pause, and the next one
     * after the resume. Answers every request, even one that changes nothing.
     */
    func pause() {
        guard !stopping, let stream, let ioProcID, aggregateDeviceID != 0 else { return }
        if !paused {
            let status = AudioDeviceStop(aggregateDeviceID, ioProcID)
            guard status == noErr else {
                emit(["type": "error", "code": "pause_failed",
                      "message": "Could not pause computer audio (\(status)).", "status": Int(status)])
                onPauseFailed?()
                return
            }
            paused = true
            consumerQueue.sync { _ = stream.settle() }
            consumerTimer?.schedule(deadline: .now() + pausedConsumerInterval, repeating: pausedConsumerInterval,
                                    leeway: .milliseconds(50))
        }
        emit(["type": "paused", "outputFrames": Int(consumerQueue.sync { stream.outputFrames })])
    }

    /** Starts the device's IO again. The first buffer after it comes with its own first-buffer event. */
    func resume() {
        guard !stopping, let stream, let ioProcID, aggregateDeviceID != 0 else { return }
        if paused {
            consumerQueue.sync { stream.restartTiming() }
            consumerTimer?.schedule(deadline: .now(), repeating: consumerInterval, leeway: .milliseconds(5))
            let status = AudioDeviceStart(aggregateDeviceID, ioProcID)
            guard status == noErr else {
                emit(["type": "error", "code": "resume_failed",
                      "message": "Could not resume computer audio (\(status)).", "status": Int(status)])
                onPauseFailed?()
                return
            }
            paused = false
        }
        emit(["type": "resumed", "outputFrames": Int(consumerQueue.sync { stream.outputFrames })])
    }

    /** Rebuild the private aggregate and converter when the hardware route or
     * tap format changes. The parent preserves audio and starts a fresh clock;
     * it must not keep interpreting new-format packets with the old converter. */
    private func observeAudioRoute() {
        let properties: [(AudioObjectID, AudioObjectPropertySelector)] = [
            (AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice),
            (AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice),
            (tapID, kAudioTapPropertyFormat),
            (aggregateDeviceID, kAudioDevicePropertyDeviceIsAlive),
        ]
        var unavailable = false
        for (object, selector) in properties {
            var address = AudioObjectPropertyAddress(mSelector: selector,
                mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
                guard let self, !self.stopping else { return }
                emit(["type": "error", "code": "device_changed",
                      "message": "Computer audio device changed; reopening capture."])
                self.onDeviceChanged?()
            }
            let status = AudioObjectAddPropertyListenerBlock(object, &address, .main, block)
            guard status == noErr else { unavailable = true; continue }
            routeListeners.append((object, address, block))
        }
        if unavailable {
            emit(["type": "warning", "code": "route_watch_unavailable",
                  "message": "Some audio device changes cannot be monitored. If audio stops after switching devices, pause and resume recording."])
        }
    }

    private func createAggregateDevice(tapUID: String, clockDeviceUID: String) throws {
        let description: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Sea Shell System Audio",
            kAudioAggregateDeviceUIDKey: "com.seashell.system-audio.\(UUID().uuidString)",
            // A process tap is not a hardware clock. Pin the current system output
            // as the aggregate's clock source, matching AudioCap and Recap.
            kAudioAggregateDeviceMainSubDeviceKey: clockDeviceUID,
            kAudioAggregateDeviceSubDeviceListKey: [[
                kAudioSubDeviceUIDKey: clockDeviceUID,
            ]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapUID,
                kAudioSubTapDriftCompensationKey: true,
            ]],
            kAudioAggregateDeviceTapAutoStartKey: true,
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

    private func readDefaultSystemOutputUID() throws -> String {
        var deviceID = AudioDeviceID()
        var deviceSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var deviceAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &deviceAddress,
            0,
            nil,
            &deviceSize,
            &deviceID
        )
        guard status == noErr, deviceID != kAudioObjectUnknown else {
            throw captureError("Could not read the system output device", status, "get_clock_device")
        }

        var uid = "" as CFString
        var uidSize = UInt32(MemoryLayout<CFString>.size)
        var uidAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        status = withUnsafeMutablePointer(to: &uid) { pointer in
            AudioObjectGetPropertyData(
                deviceID,
                &uidAddress,
                0,
                nil,
                &uidSize,
                pointer
            )
        }
        guard status == noErr, !String(uid).isEmpty else {
            throw captureError("Could not read the system output identity", status, "get_clock_device_uid")
        }
        return uid as String
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

    private func readSourceFormat() throws {
        var description = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyFormat,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &description)
        guard status == noErr else {
            throw captureError("Could not read the system-audio format", status, "get_tap_format")
        }
        guard let sourceFormat = AVAudioFormat(streamDescription: &description) else {
            throw captureError("Could not interpret the system-audio format", nil, "source_format")
        }
        self.sourceFormat = sourceFormat
    }

    private func registerIOProc() throws {
        guard let stream else {
            throw captureError("System-audio packet ring is unavailable", nil, "register_ioproc")
        }
        var processID: AudioDeviceIOProcID?
        // The block is C and captures only the ring's address: no queue, no
        // Swift or Objective-C object, no lock, no allocation, no system call.
        let status = seashell_audio_ring_create_ioproc(stream.ring, aggregateDeviceID, &processID)
        guard status == noErr, let processID else {
            throw captureError("Could not register the system-audio callback", status, "create_ioproc")
        }
        ioProcID = processID
    }

    private func startConsumer() {
        guard let stream else { return }
        let timer = DispatchSource.makeTimerSource(queue: consumerQueue)
        timer.schedule(deadline: .now(), repeating: consumerInterval, leeway: .milliseconds(5))
        timer.setEventHandler { stream.drain() }
        timer.resume()
        consumerTimer = timer
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

/** One event per line on stderr, in a single write: a line from the consumer
 * and one from the main queue never interleave. A closed stderr is ignored,
 * where FileHandle would raise. */
func emit(_ event: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(event),
          var data = try? JSONSerialization.data(withJSONObject: event) else { return }
    data.append(0x0a)
    data.withUnsafeBytes { bytes in
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

/**
 * The whole consumer on synthetic packets shaped like the tap's: a 440 Hz tone
 * pushed through the IO block's own body into the ring, converted to the
 * 16 kHz stream, and written to a pipe whose reader first stays away. The
 * consumer stalls too, then a pause and a resume. Every dropped frame must
 * come out as silence exactly where a discontinuity says, the tone everywhere
 * else, and the stream as long as the audio pushed in.
 */
@available(macOS 14.2, *)
private func pipelineCheck(_ tap: AVAudioFormat, failures: inout [[String: Any]]) -> [String: Any] {
    let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    var descriptors: [Int32] = [0, 0]
    var events: [[String: Any]] = []
    guard pipe(&descriptors) == 0,
          let stream = SystemAudioStream(sourceFormat: tap, targetFormat: target, chunkMilliseconds: 100, probe: false,
                                         output: descriptors[1], outputSeconds: 4, emit: { events.append($0) }),
          let packet = AVAudioPCMBuffer(pcmFormat: tap, frameCapacity: 512) else {
        failures.append(["check": "pipeline", "error": "could not set up"])
        return [:]
    }
    packet.frameLength = 512
    var pushed: UInt64 = 0
    func push(seconds: Double, drainEvery: Int?) {
        let packets = Int(seconds * tap.sampleRate / 512)
        for index in 0..<packets {
            let samples = packet.floatChannelData![0]
            for frame in 0..<512 {
                samples[frame] = Float(0.25 * sin(2 * Double.pi * 440 * Double(pushed + UInt64(frame)) / tap.sampleRate))
            }
            var time = AudioTimeStamp()
            time.mSampleTime = Double(pushed)
            time.mHostTime = mach_absolute_time()
            time.mFlags = [.sampleTimeValid, .hostTimeValid]
            _ = seashell_audio_ring_write_device(stream.ring, packet.audioBufferList, &time)
            pushed += 512
            if let drainEvery, index % drainEvery == drainEvery - 1 { stream.drain() }
        }
        if drainEvery != nil { stream.drain() }
    }
    // Nobody reads stdout; then the consumer stalls past what the ring holds, and catches up.
    push(seconds: 5, drainEvery: 10)
    push(seconds: 12, drainEvery: nil)
    stream.drain()
    let reader = PipeReader(fd: descriptors[0])
    reader.start()
    let delivered = stream.deliver(timeoutMs: 5_000)
    push(seconds: 3, drainEvery: 10)
    // A pause: the stream's length is where the audio after the resume begins.
    let pushedBeforePause = pushed
    let pausedAt = stream.settle()
    stream.restartTiming()
    push(seconds: 1, drainEvery: 10)
    stream.finish(timeoutMs: 5_000)
    close(descriptors[1])
    reader.wait()
    close(descriptors[0])

    let samples: [Int16] = reader.bytes.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    let gaps = events.filter { $0["type"] as? String == "discontinuity" }.map {
        (stage: $0["stage"] as? String ?? "", start: $0["outputFrames"] as? Int ?? -1, frames: $0["droppedFrames"] as? Int ?? 0)
    }
    let firstBuffers = events.filter { $0["type"] as? String == "first-buffer" }.map { $0["outputFrames"] as? Int ?? -1 }
    let captureFrames = gaps.filter { $0.stage == "capture" }.reduce(0) { $0 + $1.frames }
    let outputFrames = gaps.filter { $0.stage == "output" }.reduce(0) { $0 + $1.frames }
    let droppedSource = seashell_audio_ring_dropped_frames(stream.ring)
    let ratio = target.sampleRate / tap.sampleRate
    let silentInGaps = gaps.allSatisfy { gap in
        gap.start >= 0 && gap.start + gap.frames <= samples.count &&
            samples[gap.start..<(gap.start + gap.frames)].allSatisfy { $0 == 0 }
    }
    // Every 100 ms of the stream that no gap touches still carries the tone.
    var windows = 0, quietWindows = 0, windowsAfterGaps = 0
    let lastGapEnd = gaps.map { $0.start + $0.frames }.max() ?? 0
    var window = 0
    while window + 1_600 <= samples.count {
        let range = window..<(window + 1_600)
        if !gaps.contains(where: { $0.start < range.upperBound && range.lowerBound < $0.start + $0.frames }) {
            windows += 1
            if window >= lastGapEnd { windowsAfterGaps += 1 }
            if (samples[range].map { abs(Int32($0)) }.max() ?? 0) < 7_000 { quietWindows += 1 }
        }
        window += 1_600
    }
    let expectedFrames = Double(pushed) * ratio
    let lengthKept = delivered && samples.count == Int(stream.outputFrames) && abs(Double(samples.count) - expectedFrames) <= 64
    let pauseExact = abs(Double(pausedAt) - Double(pushedBeforePause) * ratio) <= 2
    let checks: [(String, Bool)] = [
        ("the stream is as long as the audio pushed in", lengthKept),
        ("frames the stalled consumer missed come out as one capture gap of their length",
         gaps.filter { $0.stage == "capture" }.count == 1 && abs(Double(captureFrames) - Double(droppedSource) * ratio) <= 1),
        ("audio the stalled reader missed is marked as output gaps", outputFrames > 0),
        ("every gap is silence, in place", silentInGaps),
        ("the tone is everywhere else, after the gaps too", windows > 0 && quietWindows == 0 && windowsAfterGaps > 0),
        ("the pause falls exactly after the audio before it, and the resume's first buffer says where",
         pauseExact && firstBuffers == [0, Int(pausedAt)]),
    ]
    for (name, passed) in checks where !passed { failures.append(["check": "pipeline", "error": name]) }
    return [
        "streamFrames": samples.count, "expectedFrames": Int(expectedFrames.rounded()),
        "captureGapFrames": captureFrames, "outputGapFrames": outputFrames, "gaps": gaps.count,
        "toneWindows": windows, "quietWindows": quietWindows, "pausedAtFrame": Int(pausedAt),
    ]
}

/** Runs the capture's handoff on synthetic packets. No audio device is opened and nothing is recorded. */
@available(macOS 14.2, *)
private func handoffCheck() -> Bool {
    var failures: [[String: Any]] = []
    // The tap's shape: mono Float32 at the output device's rate, in IO-sized packets.
    let tap = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    var ring = seashell_ring_check()
    _ = seashell_ring_check_run(tap.streamDescription, 512, true, &ring)
    let ringChecks: [(String, Bool)] = [
        ("the IO thread never waits for a stalled consumer", ring.producerFinished),
        ("the ring holds at least 4 s", ring.ringSeconds >= 4),
        ("every dropped frame is counted", ring.droppedFrames > 0 && ring.countedDrops == ring.droppedFrames),
        ("every frame comes out once, in order, with gaps where frames were dropped", ring.orderKept),
        ("the same with both threads running", ring.concurrentOrderKept),
        ("a write on the IO thread takes under 2 ms", !ring.realtime || ring.maxWriteMicroseconds < 2_000),
    ]
    for (name, passed) in ringChecks where !passed { failures.append(["check": "ring", "error": name]) }
    // 30 s of the 16 kHz stream, in 100 ms writes, as the capture uses it.
    var output = seashell_pipe_check()
    _ = seashell_pipe_check_run(Int(pipeSeconds * 32_000), 3_200, &output)
    let pipeChecks: [(String, Bool)] = [
        ("stdout is non-blocking", output.nonblocking),
        ("no write waits for a reader that is away", output.writerFinished),
        ("what does not fit is replaced", output.replacedBytes > 0),
        ("the stream keeps its length", output.lengthKept),
        ("every byte is where it was written, or silence where it was replaced", output.orderKept),
        ("out of marks, audio turns to silence in place", output.marksExhaustedInPlace),
        ("a closed reader is reported, not fatal", output.readerGoneDetected),
    ]
    for (name, passed) in pipeChecks where !passed { failures.append(["check": "stdout", "error": name]) }
    let pipeline = pipelineCheck(tap, failures: &failures)
    let report: [String: Any] = [
        "ring": [
            "realtimeThread": ring.realtime, "seconds": rounded(ring.ringSeconds),
            "pushedFrames": ring.pushedFrames, "storedFrames": ring.storedFrames, "droppedFrames": ring.droppedFrames,
            "countedDrops": ring.countedDrops, "maxWriteMicroseconds": rounded(ring.maxWriteMicroseconds),
            "concurrentPackets": ring.concurrentPackets, "concurrentDroppedFrames": ring.concurrentDroppedFrames,
        ],
        "stdout": [
            "nonblocking": output.nonblocking, "bytes": output.bytes, "replacedBytes": output.replacedBytes,
            "maxAppendMicroseconds": rounded(output.maxAppendMicroseconds),
        ],
        "pipeline": pipeline,
        "failures": failures,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    return failures.isEmpty
}

// MARK: - Responsibility

private let disclaimedEnvironment = "SEASHELL_SYSTEM_AUDIO_RESPONSIBLE"
private let launchArguments = Array(CommandLine.arguments.dropFirst())

private typealias DisclaimFunction = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32

private func executablePath() -> String? {
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size) + 1)
    guard _NSGetExecutablePath(&buffer, &size) == 0 else { return nil }
    return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path
}

/// Relaunch as a process responsible for itself, proxying termination signals
/// and the exit status. Returns only when that is unavailable. Audio and events
/// reach the launcher directly: the relaunched helper inherits its pipes.
private func relaunchResponsibleForItself() {
    guard getenv(disclaimedEnvironment) == nil, !launchArguments.contains("--no-disclaim"),
          // RTLD_DEFAULT; the symbol is private but stable since macOS 10.14.
          let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim"),
          let path = executablePath() else { return }
    let disclaim = unsafeBitCast(symbol, to: DisclaimFunction.self)
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return }
    defer { posix_spawnattr_destroy(&attributes) }
    guard disclaim(&attributes, 1) == 0 else { return }
    setenv(disclaimedEnvironment, "1", 1)
    let argv: [UnsafeMutablePointer<CChar>?] = ([path] + launchArguments).map { strdup($0) } + [nil]
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

// A closed stdout or stderr is reported by write, not by a signal that kills mid-teardown.
signal(SIGPIPE, SIG_IGN)
// Pause and resume (SIGUSR1, SIGUSR2) are for the capture, never fatal: the
// proxy ignores them, and the relaunched helper inherits that until its
// handlers are in place. Signal the process group, as for a stop.
signal(SIGUSR1, SIG_IGN)
signal(SIGUSR2, SIG_IGN)

/// Runs the capture's own handoff and conversion on synthetic packets, with a
/// stalled consumer and a stalled reader. No audio device is opened.
if launchArguments.contains("--handoff-check") {
    if #available(macOS 14.2, *) { exit(handoffCheck() ? 0 : 1) }
    exit(1)
}

relaunchResponsibleForItself()

/// Which identity macOS judges, without opening a tap or asking for anything.
if launchArguments.contains("--identity") {
    let report: [String: Any] = [
        "responsibleForItself": getenv(disclaimedEnvironment) != nil,
        "executable": executablePath() ?? CommandLine.arguments[0],
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys, .withoutEscapingSlashes]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    exit(0)
}

if #available(macOS 14.2, *) {
    let config = parseConfig()
    let capture = SystemAudioCapture(config: config)
    var signalSources: [DispatchSourceSignal] = []

    func stopAndExit(_ code: Int32) -> Never {
        capture.stop()
        exit(code)
    }
    capture.onDeviceChanged = { stopAndExit(1) }
    capture.onReaderGone = { stopAndExit(0) }
    capture.onPauseFailed = { stopAndExit(1) }

    // A proxy killed with SIGKILL cannot forward a stop. Never outlive it.
    let launchParent = getppid()
    let parentWatch = DispatchSource.makeTimerSource(queue: .main)
    parentWatch.schedule(deadline: .now() + 0.5, repeating: 0.5)
    parentWatch.setEventHandler { if getppid() != launchParent { stopAndExit(0) } }
    parentWatch.resume()

    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    for signalValue in [SIGINT, SIGTERM] {
        let source = DispatchSource.makeSignalSource(signal: signalValue, queue: .main)
        source.setEventHandler { stopAndExit(0) }
        source.resume()
        signalSources.append(source)
    }
    // In place before the capture starts, so a request sent after its start
    // event is never lost. The main queue runs them one at a time, after start.
    for (signalValue, action) in [(SIGUSR1, capture.pause), (SIGUSR2, capture.resume)] {
        let source = DispatchSource.makeSignalSource(signal: signalValue, queue: .main)
        source.setEventHandler { action() }
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
