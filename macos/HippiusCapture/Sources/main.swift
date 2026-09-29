import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

/// HippiusCapture — a tiny ScreenCaptureKit → H.264/AAC MP4 helper.
///
/// Spoken to over stdin/stdout as one JSON object per line. Rust owns the
/// session; this process only encodes. Events:
///   {"ok":true,"event":"ready"}
///   {"ok":true,"event":"started"|"paused"|"resumed"|"stopped"|"cancelled"}
///   {"ok":false,"error":"..."}
@main
struct HippiusCaptureMain {
    static func main() {
        // `--list-microphones`: print the microphones as JSON and exit. Rust
        // offers them in the capture bar and passes the chosen id to "start".
        if CommandLine.arguments.contains("--list-microphones") {
            listMicrophones()
            return
        }
        let runner = Runner()
        runner.emit(["ok": true, "event": "ready"])
        runner.run()
    }
}

/// `[{"id": uniqueID, "name": localizedName}]` on one line.
func listMicrophones() {
    let types: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
        types = [.microphone, .external]
    } else {
        types = [.builtInMicrophone, .externalUnknown]
    }
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .audio, position: .unspecified).devices
    let list = devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
    if let data = try? JSONSerialization.data(withJSONObject: list),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("[]")
    }
}

final class Runner: @unchecked Sendable {
    private let lock = NSLock()
    private var session: RecordSession?

    func run() {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            handle(line)
        }
        lock.lock()
        let live = session
        session = nil
        lock.unlock()
        live?.cancel()
    }

    private func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String
        else {
            emit(["ok": false, "error": "malformed command"])
            return
        }
        switch cmd {
        case "start":
            start(obj)
        case "pause":
            withSession { $0.pause(); emit(["ok": true, "event": "paused"]) }
        case "resume":
            withSession { $0.resume(); emit(["ok": true, "event": "resumed"]) }
        case "stop":
            stop()
        case "cancel":
            cancel()
        default:
            emit(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    }

    private func start(_ obj: [String: Any]) {
        lock.lock()
        let busy = session != nil
        lock.unlock()
        if busy {
            emit(["ok": false, "error": "already recording"])
            return
        }
        guard let output = obj["output"] as? String else {
            emit(["ok": false, "error": "missing output path"])
            return
        }
        let microphone = (obj["microphone"] as? Bool) ?? false
        let showClicks = (obj["showClicks"] as? Bool) ?? false
        let microphoneDeviceId = obj["microphoneDeviceId"] as? String
        let displayId = intU32(obj["displayId"])
        let windowId = intU32(obj["windowId"])
        let crop: CGRect? = {
            guard let c = obj["crop"] as? [String: Any],
                  let x = double(c["x"]),
                  let y = double(c["y"]),
                  let w = double(c["width"]),
                  let h = double(c["height"]),
                  w > 0, h > 0
            else { return nil }
            return CGRect(x: x, y: y, width: w, height: h)
        }()

        let sem = DispatchSemaphore(value: 0)
        var result: Result<RecordSession, Error> = .failure(CaptureError.writerFailed("start did not complete"))
        Task {
            do {
                let session = try await RecordSession.start(
                    outputURL: URL(fileURLWithPath: output),
                    displayId: displayId,
                    windowId: windowId,
                    crop: crop,
                    microphone: microphone,
                    microphoneDeviceId: microphoneDeviceId,
                    showClicks: showClicks
                )
                result = .success(session)
            } catch {
                result = .failure(error)
            }
            sem.signal()
        }
        // ScreenCaptureKit needs the main run loop while the Task awaits.
        while sem.wait(timeout: .now() + 0.05) == .timedOut {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        switch result {
        case .success(let session):
            lock.lock()
            self.session = session
            lock.unlock()
            emit(["ok": true, "event": "started"])
        case .failure(let error):
            emit(["ok": false, "error": error.localizedDescription])
        }
    }

    private func stop() {
        lock.lock()
        let live = session
        session = nil
        lock.unlock()
        guard let live else {
            emit(["ok": false, "error": "not recording"])
            return
        }
        let sem = DispatchSemaphore(value: 0)
        var error: Error?
        Task {
            do {
                try await live.stop()
            } catch let e {
                error = e
            }
            sem.signal()
        }
        while sem.wait(timeout: .now() + 0.05) == .timedOut {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        if let error {
            emit(["ok": false, "error": error.localizedDescription])
        } else {
            emit(["ok": true, "event": "stopped"])
        }
    }

    private func cancel() {
        lock.lock()
        let live = session
        session = nil
        lock.unlock()
        live?.cancel()
        emit(["ok": true, "event": "cancelled"])
    }

    private func withSession(_ body: (RecordSession) -> Void) {
        lock.lock()
        let live = session
        lock.unlock()
        guard let live else {
            emit(["ok": false, "error": "not recording"])
            return
        }
        body(live)
    }

    func emit(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let line = String(data: data, encoding: .utf8)
        else { return }
        fputs(line + "\n", stdout)
        fflush(stdout)
    }
}

private func intU32(_ value: Any?) -> UInt32? {
    switch value {
    case let n as NSNumber: return n.uint32Value
    case let i as Int: return UInt32(i)
    case let u as UInt32: return u
    case let d as Double: return UInt32(d)
    default: return nil
    }
}

private func double(_ value: Any?) -> Double? {
    switch value {
    case let n as NSNumber: return n.doubleValue
    case let d as Double: return d
    case let i as Int: return Double(i)
    default: return nil
    }
}

// MARK: - Recording session

enum CaptureError: LocalizedError {
    case noDisplay
    case noWindow
    case writerFailed(String)

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "That display is no longer connected."
        case .noWindow: return "That window has closed."
        case .writerFailed(let s): return s
        }
    }
}

final class RecordSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let writer: AVAssetWriter
    private var videoInput: AVAssetWriterInput
    private var audioInput: AVAssetWriterInput?
    private var micInput: AVAssetWriterInput?
    private let writerQueue = DispatchQueue(label: "com.hippius.capture.writer")
    private var started = false
    private var paused = false
    private let outputURL: URL

    static func start(
        outputURL: URL,
        displayId: UInt32?,
        windowId: UInt32?,
        crop: CGRect?,
        microphone: Bool,
        microphoneDeviceId: String?,
        showClicks: Bool
    ) async throws -> RecordSession {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        var sampleWidth: CGFloat = 1920
        var sampleHeight: CGFloat = 1080
        var sourceRect: CGRect?

        if let windowId {
            guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
                throw CaptureError.noWindow
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            sampleWidth = CGFloat(window.frame.width)
            sampleHeight = CGFloat(window.frame.height)
        } else {
            let display: SCDisplay
            if let displayId {
                guard let match = content.displays.first(where: { $0.displayID == displayId }) else {
                    throw CaptureError.noDisplay
                }
                display = match
            } else {
                guard let first = content.displays.first else { throw CaptureError.noDisplay }
                display = first
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            sampleWidth = CGFloat(display.width)
            sampleHeight = CGFloat(display.height)
            if let crop {
                sourceRect = crop
                sampleWidth = crop.width
                sampleHeight = crop.height
            }
        }

        let pixelWidth = max(2, Int(sampleWidth.rounded()) & ~1)
        let pixelHeight = max(2, Int(sampleHeight.rounded()) & ~1)

        let config = SCStreamConfiguration()
        config.width = pixelWidth
        config.height = pixelHeight
        config.capturesAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.showsCursor = true
        config.queueDepth = 8
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        if let sourceRect {
            config.sourceRect = sourceRect
        }
        if #available(macOS 15.0, *), microphone {
            config.captureMicrophone = true
            if let microphoneDeviceId, !microphoneDeviceId.isEmpty {
                config.microphoneCaptureDeviceID = microphoneDeviceId
            }
        }
        if #available(macOS 15.0, *), showClicks {
            config.showMouseClicks = true
        }

        try? FileManager.default.removeItem(at: outputURL)
        let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: pixelWidth,
            AVVideoHeightKey: pixelHeight,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: max(1_000_000, pixelWidth * pixelHeight * 4),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
            ]
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = true
        guard writer.canAdd(videoInput) else {
            throw CaptureError.writerFailed("Could not add the video track.")
        }
        writer.add(videoInput)

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 128_000
        ]
        let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput.expectsMediaDataInRealTime = true
        if writer.canAdd(audioInput) {
            writer.add(audioInput)
        }

        var micInput: AVAssetWriterInput?
        if #available(macOS 15.0, *), microphone {
            let micSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000
            ]
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: micSettings)
            input.expectsMediaDataInRealTime = true
            if writer.canAdd(input) {
                writer.add(input)
                micInput = input
            }
        }

        guard writer.startWriting() else {
            throw CaptureError.writerFailed(writer.error?.localizedDescription ?? "writer failed")
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let session = RecordSession(
            stream: stream,
            writer: writer,
            videoInput: videoInput,
            audioInput: writer.inputs.contains(audioInput) ? audioInput : nil,
            micInput: micInput,
            outputURL: outputURL
        )
        // Re-create with the session as delegate so stop-with-error is reported.
        let streamWithDelegate = SCStream(filter: filter, configuration: config, delegate: session)
        session.replaceStream(streamWithDelegate)
        try streamWithDelegate.addStreamOutput(session, type: .screen, sampleHandlerQueue: session.writerQueue)
        try streamWithDelegate.addStreamOutput(session, type: .audio, sampleHandlerQueue: session.writerQueue)
        if #available(macOS 15.0, *), microphone {
            try? streamWithDelegate.addStreamOutput(session, type: .microphone, sampleHandlerQueue: session.writerQueue)
        }
        try await streamWithDelegate.startCapture()
        return session
    }

    private var stream: SCStream

    private init(
        stream: SCStream,
        writer: AVAssetWriter,
        videoInput: AVAssetWriterInput,
        audioInput: AVAssetWriterInput?,
        micInput: AVAssetWriterInput?,
        outputURL: URL
    ) {
        self.stream = stream
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        self.micInput = micInput
        self.outputURL = outputURL
        super.init()
    }

    fileprivate func replaceStream(_ stream: SCStream) {
        self.stream = stream
    }

    func pause() {
        paused = true
    }

    func resume() {
        paused = false
    }

    func stop() async throws {
        try await stream.stopCapture()
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            writerQueue.async {
                self.videoInput.markAsFinished()
                self.audioInput?.markAsFinished()
                self.micInput?.markAsFinished()
                self.writer.finishWriting {
                    cont.resume()
                }
            }
        }
        if writer.status == .failed {
            throw CaptureError.writerFailed(writer.error?.localizedDescription ?? "finish failed")
        }
    }

    func cancel() {
        stream.stopCapture { _ in }
        writerQueue.async {
            if self.writer.status == .writing {
                self.writer.cancelWriting()
            }
        }
        try? FileManager.default.removeItem(at: outputURL)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !paused, CMSampleBufferIsValid(sampleBuffer) else { return }
        if !started {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: pts)
            started = true
        }
        switch type {
        case .screen:
            if videoInput.isReadyForMoreMediaData {
                videoInput.append(sampleBuffer)
            }
        case .audio:
            if let audioInput, audioInput.isReadyForMoreMediaData {
                audioInput.append(sampleBuffer)
            }
        case .microphone:
            if let micInput, micInput.isReadyForMoreMediaData {
                micInput.append(sampleBuffer)
            }
        @unknown default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let msg = error.localizedDescription.replacingOccurrences(of: "\"", with: "'")
        fputs("{\"ok\":false,\"error\":\"\(msg)\"}\n", stderr)
        fflush(stderr)
    }
}
