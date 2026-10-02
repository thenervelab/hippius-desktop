import AVFoundation
import CoreMedia
import Foundation

/// `--meter [deviceId]`: the capture bar's microphone level, measured here
/// instead of in a webview.
///
/// WebKit lets only ONE page in a process capture at a time: a page that
/// starts `getUserMedia` mutes every other page's camera and microphone, and
/// they stay muted (a black camera) until they ask again. The camera bubble
/// must be a webview (it is filmed), so the meter beside the microphone row
/// cannot be one too, or each one turning on blacks out the other. WebKit's
/// microphone also runs Apple's voice processing, which changes what every
/// other process hears from that microphone, the recording included, for as
/// long as it is open and a few seconds after.
///
/// Plain AVFoundation, no voice processing. Prints, one JSON object per line:
///   {"ok":true,"event":"ready"}
///   {"event":"level","rms":0.0123}   about every 50 ms
///   {"ok":false,"error":"..."}       then exits 1
/// Exits when stdin closes, so the app closing it (or dying) frees the
/// microphone at once.
func runMeter(deviceId: String?) -> Never {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .denied, .restricted:
        emit(["ok": false, "error": "Microphone access is off for Hippius."])
        exit(1)
    case .notDetermined:
        let asked = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in asked.signal() }
        asked.wait()
        if AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
            emit(["ok": false, "error": "Microphone access is off for Hippius."])
            exit(1)
        }
    default:
        break
    }

    let meter = LevelMeter()
    if let problem = meter.start(deviceId: deviceId) {
        emit(["ok": false, "error": problem])
        exit(1)
    }
    emit(["ok": true, "event": "ready"])

    // Stdin closing is the stop signal: Rust closes it, or the app died.
    DispatchQueue.global(qos: .utility).async {
        while readLine(strippingNewline: true) != nil {}
        meter.stop()
        exit(0)
    }
    dispatchMain()
}

final class LevelMeter: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    /// How often a level is printed.
    static let interval: UInt64 = 50_000_000

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.hippius.capture.meter")
    // Read and written on `queue` only.
    private var sumOfSquares: Double = 0
    private var sampleCount = 0
    private var windowStart = DispatchTime.now().uptimeNanoseconds

    /// Open the microphone: the chosen one by its id (the same id the bar
    /// lists and the recording uses), else the system default. Nil when it
    /// is running, else why not.
    func start(deviceId: String?) -> String? {
        let chosen = deviceId.flatMap { $0.isEmpty ? nil : AVCaptureDevice(uniqueID: $0) }
        guard let device = chosen ?? AVCaptureDevice.default(for: .audio) else {
            return "No microphone was found."
        }
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            return "The microphone could not be opened: \(error.localizedDescription)"
        }
        let output = AVCaptureAudioDataOutput()
        // Float samples whatever the device delivers, so one sum works for
        // every microphone.
        output.audioSettings = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsNonInterleaved: false
        ]
        output.setSampleBufferDelegate(self, queue: queue)
        session.beginConfiguration()
        guard session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            return "The microphone could not be opened."
        }
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()
        return nil
    }

    func stop() {
        session.stopRunning()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        var blockBuffer: CMBlockBuffer?
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &needed, bufferListOut: nil, bufferListSize: 0,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil
        )
        guard needed > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.assumingMemoryBound(to: AudioBufferList.self)
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list, bufferListSize: needed,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }
        for buffer in UnsafeMutableAudioBufferListPointer(list) {
            guard let data = buffer.mData else { continue }
            let samples = data.assumingMemoryBound(to: Float.self)
            let count = Int(buffer.mDataByteSize) / MemoryLayout<Float>.size
            for i in 0..<count {
                let s = Double(samples[i])
                sumOfSquares += s * s
            }
            sampleCount += count
        }
        let now = DispatchTime.now().uptimeNanoseconds
        if now - windowStart >= Self.interval {
            let rms = sampleCount > 0 ? (sumOfSquares / Double(sampleCount)).squareRoot() : 0
            emit(["event": "level", "rms": rms])
            sumOfSquares = 0
            sampleCount = 0
            windowStart = now
        }
    }
}
