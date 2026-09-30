import AVFoundation
import CoreAudio
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

/// HippiusCapture — a tiny ScreenCaptureKit → H.264/AAC MP4 helper.
///
/// Spoken to over stdin/stdout as one JSON object per line. Rust owns the
/// session; this process only encodes. Commands carry an optional `"id"`,
/// echoed on their reply. Events:
///   {"ok":true,"event":"ready"}
///   {"ok":true,"event":"started"|"paused"|"resumed"|"stopped"|"cancelled","id":n}
///   {"ok":false,"error":"...","id":n}
///   {"ok":false,"event":"stream_stopped","error":"...","saved":bool}
///     unprompted: the stream ended on its own and the file was finished
///     (`saved`) with what it had.
/// Diagnostics go to stderr as plain lines; Rust logs them.
@main
struct HippiusCaptureMain {
    static func main() {
        // A plain command-line tool has no window-server connection until
        // something asks for one. ScreenCaptureKit's display path opens it
        // itself, but building a window filter does not and aborts in
        // CGS_REQUIRE_INIT, so touch CoreGraphics before any SCK call.
        _ = CGMainDisplayID()
        // `--list-microphones`: print the microphones as JSON and exit. Rust
        // offers them in the capture bar and passes the chosen id to "start".
        if CommandLine.arguments.contains("--list-microphones") {
            printDevices(listMicrophones())
            return
        }
        // `--list-cameras`: the same for cameras, so the bar can offer them
        // before the camera window has opened one.
        if CommandLine.arguments.contains("--list-cameras") {
            printDevices(listCameras())
            return
        }
        let runner = Runner()
        emit(["ok": true, "event": "ready"])
        runner.run()
    }
}

/// One device as Rust reads it (`recording::MediaDevice`).
struct ListedDevice {
    let id: String
    let name: String
    var isDefault: Bool
}

/// `[{"id": uniqueID, "name": localizedName, "isDefault": bool}]` on one line.
/// Rust drops repeats and puts the default first (`recording::tidy_devices`).
func printDevices(_ devices: [ListedDevice]) {
    let list = devices.map { ["id": $0.id, "name": $0.name, "isDefault": $0.isDefault] as [String: Any] }
    if let data = try? JSONSerialization.data(withJSONObject: list),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print("[]")
    }
}

/// Every audio input on the Mac: built-in, USB, Bluetooth, Continuity
/// (iPhone), display and virtual devices (Loopback, BlackHole, meeting apps).
///
/// Two sources, merged: AVFoundation's discovery session, and Core Audio's own
/// device list. The discovery session alone leaves some devices out
/// (`.external` on macOS 14 is cameras only; older type lists miss virtual
/// devices), while Core Audio sees every device with an input stream. A Core
/// Audio device's UID is the same string as `AVCaptureDevice.uniqueID`, which
/// is what ScreenCaptureKit's `microphoneCaptureDeviceID` takes.
func listMicrophones() -> [ListedDevice] {
    var types: [AVCaptureDevice.DeviceType]
    if #available(macOS 14.0, *) {
        types = [.microphone]
    } else {
        types = [.builtInMicrophone, .externalUnknown]
    }
    let discovered = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .audio, position: .unspecified).devices
    let defaultId = AVCaptureDevice.default(for: .audio)?.uniqueID ?? coreAudioDefaultInputUID()
    var out = discovered.map { ListedDevice(id: $0.uniqueID, name: $0.localizedName, isDefault: $0.uniqueID == defaultId) }
    for device in coreAudioInputDevices() where !out.contains(where: { $0.id == device.id }) {
        out.append(ListedDevice(id: device.id, name: device.name, isDefault: device.id == defaultId))
    }
    return out
}

/// Every camera: built-in, USB, display cameras, Continuity Camera and Desk
/// View. Names are `localizedName`, which is also the label the webview gives
/// the same camera, so the camera window can find it by name.
func listCameras() -> [ListedDevice] {
    var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
    if #available(macOS 14.0, *) {
        types += [.external, .continuityCamera, .deskViewCamera]
    } else {
        types += [.externalUnknown, .deskViewCamera]
    }
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified).devices
    let defaultId = AVCaptureDevice.default(for: .video)?.uniqueID
    return devices.map { ListedDevice(id: $0.uniqueID, name: $0.localizedName, isDefault: $0.uniqueID == defaultId) }
}

private func coreAudioProperty(_ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

private func coreAudioString(_ device: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var address = coreAudioProperty(selector)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
    guard status == noErr, let value else { return nil }
    return value.takeRetainedValue() as String
}

/// Whether the device has at least one input channel.
private func coreAudioHasInput(_ device: AudioObjectID) -> Bool {
    var address = coreAudioProperty(kAudioDevicePropertyStreamConfiguration, scope: kAudioDevicePropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return false }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return false }
    let buffers = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return buffers.contains { $0.mNumberChannels > 0 }
}

private func coreAudioInputDevices() -> [(id: String, name: String)] {
    var address = coreAudioProperty(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    let system = AudioObjectID(kAudioObjectSystemObject)
    guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { device in
        guard coreAudioHasInput(device),
              let uid = coreAudioString(device, kAudioDevicePropertyDeviceUID),
              let name = coreAudioString(device, kAudioObjectPropertyName)
        else { return nil }
        return (uid, name)
    }
}

private func coreAudioDefaultInputUID() -> String? {
    var address = coreAudioProperty(kAudioHardwarePropertyDefaultInputDevice)
    var device = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
          device != 0
    else { return nil }
    return coreAudioString(device, kAudioDevicePropertyDeviceUID)
}

// MARK: - Protocol

/// Replies come from the main thread, while a stream that stops on its own
/// reports from ScreenCaptureKit's queue; one line must never split another.
private let emitLock = NSLock()

/// One JSON object per line on stdout, flushed at once. `JSONSerialization`
/// escapes every message, so an error text with a quote, a backslash or a
/// newline cannot break the line Rust parses.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8)
    else { return }
    emitLock.lock()
    fputs(line + "\n", stdout)
    fflush(stdout)
    emitLock.unlock()
}

private final class Box<T>: @unchecked Sendable {
    var value: Result<T, Error>?
}

/// Run `body` and wait for it on the main thread, pumping the main run loop
/// meanwhile: ScreenCaptureKit needs it while a stream starts and stops.
/// `nil` when `timeout` passed first.
func pumpUntilDone<T>(timeout: TimeInterval?, _ body: @escaping () async throws -> T) -> Result<T, Error>? {
    let sem = DispatchSemaphore(value: 0)
    let box = Box<T>()
    Task {
        do {
            box.value = .success(try await body())
        } catch {
            box.value = .failure(error)
        }
        sem.signal()
    }
    let deadline = timeout.map { Date(timeIntervalSinceNow: $0) }
    while sem.wait(timeout: .now() + 0.05) == .timedOut {
        if let deadline, Date() > deadline { return nil }
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    return box.value
}

final class Runner: @unchecked Sendable {
    private let lock = NSLock()
    private var session: RecordSession?

    func run() {
        while let line = readLine(strippingNewline: true) {
            guard !line.isEmpty else { continue }
            handle(line)
        }
        // stdin closed without a stop: the app is gone (crash, force quit).
        // Keep what was recorded rather than throw it away: the file stays in
        // its capture directory for the app to find. Only an explicit
        // `cancel` deletes. Bounded, so a wedged writer cannot leave this
        // process behind; the movie fragments already on disk still play.
        guard let live = take() else { return }
        switch pumpUntilDone(timeout: 30, { try await live.finish() }) {
        case .success?:
            emit(["ok": true, "event": "stopped"])
        case .failure(let error)?:
            emit(["ok": false, "error": error.localizedDescription])
        case nil:
            emit(["ok": false, "error": "The recording did not finish in time."])
        }
    }

    private func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String
        else {
            emit(["ok": false, "error": "malformed command"])
            return
        }
        // Echoed on the reply so Rust can tell it from a late answer to an
        // earlier command.
        let id = obj["id"]
        let reply: ([String: Any]) -> Void = { body in
            var body = body
            if let id { body["id"] = id }
            emit(body)
        }
        switch cmd {
        case "start":
            start(obj, reply: reply)
        case "pause":
            guard let live = current() else { return reply(Self.notRecording) }
            live.pause()
            reply(["ok": true, "event": "paused"])
        case "resume":
            guard let live = current() else { return reply(Self.notRecording) }
            live.resume()
            reply(["ok": true, "event": "resumed"])
        case "stop":
            stop(reply: reply)
        case "cancel":
            take()?.cancel()
            reply(["ok": true, "event": "cancelled"])
        default:
            reply(["ok": false, "error": "unknown cmd: \(cmd)"])
        }
    }

    private static let notRecording: [String: Any] = ["ok": false, "error": "not recording"]

    private func current() -> RecordSession? {
        lock.lock()
        defer { lock.unlock() }
        return session
    }

    private func take() -> RecordSession? {
        lock.lock()
        defer { lock.unlock() }
        let live = session
        session = nil
        return live
    }

    private func start(_ obj: [String: Any], reply: ([String: Any]) -> Void) {
        if current() != nil {
            return reply(["ok": false, "error": "already recording"])
        }
        guard let options = StartOptions(obj) else {
            return reply(["ok": false, "error": "missing output path"])
        }
        let result = pumpUntilDone(timeout: nil) { [weak self] in
            try await RecordSession.start(options) { live, message in
                self?.streamDied(live, message)
            }
        }
        switch result {
        case .success(let live)?:
            lock.lock()
            session = live
            lock.unlock()
            reply(["ok": true, "event": "started", "width": live.width, "height": live.height])
        case .failure(let error)?:
            reply(["ok": false, "error": error.localizedDescription])
        case nil:
            reply(["ok": false, "error": "start did not complete"])
        }
    }

    private func stop(reply: ([String: Any]) -> Void) {
        guard let live = take() else { return reply(Self.notRecording) }
        switch pumpUntilDone(timeout: nil, { try await live.finish() }) {
        case .success?:
            reply(["ok": true, "event": "stopped"])
        case .failure(let error)?:
            reply(["ok": false, "error": error.localizedDescription])
        case nil:
            reply(["ok": false, "error": "stop did not complete"])
        }
    }

    /// The stream stopped by itself (display unplugged, sleep, permission
    /// revoked, an encoder failure). Finish the file with what it has and
    /// tell Rust, unprompted, so the session ends now rather than at Stop.
    ///
    /// The event goes out BEFORE the session is dropped: a `stop` that
    /// arrives in between shares the same finish and answers `stopped`, and
    /// one that arrives after reads the event first.
    private func streamDied(_ live: RecordSession, _ message: String) {
        Task {
            var saved = false
            do {
                try await live.finish()
                saved = true
            } catch {
                FileHandle.standardError.write(Data("finish after the stream stopped failed: \(error.localizedDescription)\n".utf8))
            }
            emit(["ok": false, "event": "stream_stopped", "error": message, "saved": saved])
            self.lock.withLock {
                if self.session === live { self.session = nil }
            }
        }
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

/// What `start` asks for, as `recording/macos.rs::StartCommand` sends it.
struct StartOptions {
    let outputURL: URL
    let displayId: UInt32?
    let windowId: UInt32?
    /// Display-local points, top-left origin.
    let crop: CGRect?
    /// Points trimmed off every edge of a window recording. Absent: the
    /// camera stage's margin when the window is the app's own, else none.
    let inset: CGFloat?
    let microphone: Bool
    let microphoneDeviceId: String?
    let showClicks: Bool

    init?(_ obj: [String: Any]) {
        guard let output = obj["output"] as? String, !output.isEmpty else { return nil }
        outputURL = URL(fileURLWithPath: output)
        microphone = (obj["microphone"] as? Bool) ?? false
        showClicks = (obj["showClicks"] as? Bool) ?? false
        microphoneDeviceId = obj["microphoneDeviceId"] as? String
        displayId = intU32(obj["displayId"])
        windowId = intU32(obj["windowId"])
        inset = double(obj["inset"]).map { CGFloat($0) }
        crop = {
            guard let c = obj["crop"] as? [String: Any],
                  let x = double(c["x"]),
                  let y = double(c["y"]),
                  let w = double(c["width"]),
                  let h = double(c["height"]),
                  w > 0, h > 0
            else { return nil }
            return CGRect(x: x, y: y, width: w, height: h)
        }()
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

/// The camera-only stage (`app/capture-camera/page.tsx`) draws its picture
/// inside a 6 pt margin (`p-1.5`, where the white ring and the shadow sit)
/// with 18 pt rounded corners (`rounded-[18px]`) on a transparent window.
/// ScreenCaptureKit fills transparency with black, so filming the whole
/// window gives black corners and a ring around the picture. Trimming the
/// margin plus 18 * (1 - 1/sqrt(2)) = 5.3 pt clears both the ring and the
/// corners. Pinned against the page by `recording::macos` tests.
let stageInset: CGFloat = 12

/// The longest edge a recording is encoded at. A 5K or 6K display is scaled
/// down to this, so the file stays a size people can upload and share.
let maxLongEdge = 3840

/// Pixels to points: the display's backing scale (2 on Retina).
func pixelScale(_ filter: SCContentFilter, displayID: CGDirectDisplayID?) -> CGFloat {
    if #available(macOS 14.0, *) {
        let scale = CGFloat(filter.pointPixelScale)
        if scale > 0 { return scale }
    }
    if let displayID, let mode = CGDisplayCopyDisplayMode(displayID), mode.width > 0 {
        return CGFloat(mode.pixelWidth) / CGFloat(mode.width)
    }
    return 1
}

/// `rect` (points, inside `bounds`) grown outward to whole pixels at
/// `scale`, then to an even pixel count each way (H.264 needs even sizes),
/// still inside `bounds`. Returns the rect back in points plus its pixel
/// size, so `sourceRect` and the output size describe exactly the same
/// pixels and no edge is resampled.
func alignToPixels(_ rect: CGRect, scale: CGFloat, bounds: CGRect) -> (rect: CGRect, width: Int, height: Int) {
    func axis(_ lo: CGFloat, _ hi: CGFloat, _ min: CGFloat, _ max: CGFloat) -> (CGFloat, CGFloat) {
        let floorMin = (min * scale).rounded(.up)
        let ceilMax = (max * scale).rounded(.down)
        var a = Swift.max(floorMin, (lo * scale).rounded(.down))
        var b = Swift.min(ceilMax, (hi * scale).rounded(.up))
        if b - a < 2 { b = a + 2 }
        if Int(b - a) % 2 != 0 {
            if b < ceilMax { b += 1 } else if a > floorMin { a -= 1 } else { b -= 1 }
        }
        return (a, b)
    }
    let (x0, x1) = axis(rect.minX, rect.maxX, bounds.minX, bounds.maxX)
    let (y0, y1) = axis(rect.minY, rect.maxY, bounds.minY, bounds.maxY)
    return (
        CGRect(x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale),
        Int(x1 - x0),
        Int(y1 - y0)
    )
}

/// Scale a pixel size down so its long edge fits `maxLongEdge`, keeping it
/// even.
func capped(_ width: Int, _ height: Int) -> (Int, Int) {
    let long = max(width, height)
    guard long > maxLongEdge else { return (width, height) }
    let k = Double(maxLongEdge) / Double(long)
    return (max(2, Int(Double(width) * k) & ~1), max(2, Int(Double(height) * k) & ~1))
}

/// Average bit rate for a 30 fps screen recording. About 14 Mbps at 1080p,
/// growing with the square root of the pixel count (screens are mostly
/// still, and text stays sharp well below a linear rise), bounded to
/// 2..28 Mbps so a 4K or Retina recording stays shareable. The encoder
/// spends far less than this on a still screen.
func videoBitRate(width: Int, height: Int) -> Int {
    let ratio = Double(width * height) / (1920.0 * 1080.0)
    let bps = 14_000_000 * ratio.squareRoot()
    return Int(min(28_000_000, max(2_000_000, bps)))
}

private func hostNow() -> CMTime {
    CMClockGetTime(CMClockGetHostTimeClock())
}

/// `buffer` with every timestamp moved earlier by `offset`.
private func shifted(_ buffer: CMSampleBuffer, by offset: CMTime) -> CMSampleBuffer? {
    if offset == .zero { return buffer }
    var count: CMItemCount = 0
    guard CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: 0, arrayToFill: nil, entriesNeededOut: &count) == noErr,
          count > 0
    else { return nil }
    var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
    guard CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timing, entriesNeededOut: &count) == noErr else {
        return nil
    }
    for i in timing.indices {
        if timing[i].presentationTimeStamp.isValid {
            timing[i].presentationTimeStamp = timing[i].presentationTimeStamp - offset
        }
        if timing[i].decodeTimeStamp.isValid {
            timing[i].decodeTimeStamp = timing[i].decodeTimeStamp - offset
        }
    }
    var out: CMSampleBuffer?
    guard CMSampleBufferCreateCopyWithNewTiming(
        allocator: kCFAllocatorDefault,
        sampleBuffer: buffer,
        sampleTimingEntryCount: count,
        sampleTimingArray: &timing,
        sampleBufferOut: &out
    ) == noErr else { return nil }
    return out
}

/// ScreenCaptureKit also delivers `.idle`, `.blank` and similar screen
/// samples that carry no picture (sent whenever nothing on screen changed).
/// Appending one fails the writer for good, so only `.complete` frames with
/// an image go to the encoder.
private func isCompleteFrame(_ buffer: CMSampleBuffer) -> Bool {
    guard CMSampleBufferGetImageBuffer(buffer) != nil,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = attachments.first?[.status] as? Int,
          let status = SCFrameStatus(rawValue: raw)
    else { return false }
    return status == .complete
}

final class RecordSession: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    typealias DeathHandler = (RecordSession, String) -> Void

    private let writer: AVAssetWriter
    private let videoInput: AVAssetWriterInput
    private let audioInput: AVAssetWriterInput?
    private let micInput: AVAssetWriterInput?
    private let outputURL: URL
    private let onDeath: DeathHandler
    let width: Int
    let height: Int
    fileprivate let writerQueue = DispatchQueue(label: "com.hippius.capture.writer")
    private var stream: SCStream?

    // Everything below is read and written on `writerQueue` only.
    private var sessionStarted = false
    /// No more samples: the file is being finished, or the writer failed.
    private var closed = false
    private var deathReported = false
    /// Host time the current pause began; nil while recording.
    private var pausedAt: CMTime?
    /// Finished pauses, in host time. Cut out of the timeline: a sample is
    /// moved earlier by the length of every pause that ended before it.
    private var gaps: [(start: CMTime, end: CMTime)] = []
    private var lastVideo: CMSampleBuffer?
    private var lastVideoTime = CMTime.invalid
    private var lastAudioEnd = CMTime.invalid
    private var lastMicEnd = CMTime.invalid

    private let finishLock = NSLock()
    private var finishing: Task<Void, Error>?

    static func start(_ options: StartOptions, onDeath: @escaping DeathHandler) async throws -> RecordSession {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let filter: SCContentFilter
        let scale: CGFloat
        var region: CGRect
        let bounds: CGRect
        var sourceRectWanted = false

        if let windowId = options.windowId {
            guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
                throw CaptureError.noWindow
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            let centre = CGPoint(x: window.frame.midX, y: window.frame.midY)
            let screen = content.displays.first(where: { $0.frame.contains(centre) })
            scale = pixelScale(filter, displayID: screen?.displayID)
            bounds = CGRect(origin: .zero, size: window.frame.size)
            region = bounds
            let ownWindow = window.owningApplication.map { $0.processID == getppid() } ?? false
            let inset = options.inset ?? (ownWindow ? stageInset : 0)
            if inset > 0, bounds.width > inset * 4, bounds.height > inset * 4 {
                region = bounds.insetBy(dx: inset, dy: inset)
                sourceRectWanted = true
            }
        } else {
            let display: SCDisplay
            if let displayId = options.displayId {
                guard let match = content.displays.first(where: { $0.displayID == displayId }) else {
                    throw CaptureError.noDisplay
                }
                display = match
            } else {
                guard let first = content.displays.first else { throw CaptureError.noDisplay }
                display = first
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            scale = pixelScale(filter, displayID: display.displayID)
            bounds = CGRect(x: 0, y: 0, width: display.width, height: display.height)
            region = bounds
            if let crop = options.crop {
                region = crop.intersection(bounds)
                if region.isNull || region.isEmpty { region = bounds }
                sourceRectWanted = true
            }
        }

        // Points in, pixels out: `sourceRect` stays in points while the
        // output size is the pixel count behind them, so Retina is recorded
        // at full sharpness instead of half.
        let aligned = alignToPixels(region, scale: scale, bounds: bounds)
        let (width, height) = capped(aligned.width, aligned.height)

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        if sourceRectWanted {
            config.sourceRect = aligned.rect
        }
        if #available(macOS 14.0, *) {
            config.captureResolution = .best
        }
        config.colorSpaceName = CGColorSpace.sRGB
        config.capturesAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.showsCursor = true
        config.queueDepth = 8
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        if #available(macOS 15.0, *), options.microphone {
            config.captureMicrophone = true
            if let id = options.microphoneDeviceId, !id.isEmpty {
                config.microphoneCaptureDeviceID = id
            }
        }
        if #available(macOS 15.0, *), options.showClicks {
            config.showMouseClicks = true
        }

        try? FileManager.default.removeItem(at: options.outputURL)
        let writer = try AVAssetWriter(url: options.outputURL, fileType: .mp4)
        // Fragments every few seconds: if this process is killed mid-way the
        // file on disk still plays up to the last fragment.
        writer.movieFragmentInterval = CMTime(value: 2, timescale: 1)
        // When the recording started, for Finder, Photos and players (the
        // file's own dates are when it was finished and moved).
        let created = AVMutableMetadataItem()
        created.identifier = .commonIdentifierCreationDate
        created.value = ISO8601DateFormatter().string(from: Date()) as NSString
        writer.metadata = [created]

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: videoBitRate(width: width, height: height),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: 30,
                // A keyframe at least every 2 s, so seeking in a shared link
                // lands quickly.
                AVVideoMaxKeyFrameIntervalKey: 60,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,
                AVVideoAllowFrameReorderingKey: false
            ] as [String: Any],
            // The stream is converted to sRGB above; say so, or players guess.
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2
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
        var audioInput: AVAssetWriterInput? = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
        audioInput?.expectsMediaDataInRealTime = true
        if let input = audioInput, writer.canAdd(input) {
            writer.add(input)
        } else {
            audioInput = nil
        }

        var micInput: AVAssetWriterInput?
        if #available(macOS 15.0, *), options.microphone {
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

        let session = RecordSession(
            writer: writer,
            videoInput: videoInput,
            audioInput: audioInput,
            micInput: micInput,
            outputURL: options.outputURL,
            width: width,
            height: height,
            onDeath: onDeath
        )
        // One stream, with the session as its delegate so a stop-with-error
        // reaches it.
        let stream = SCStream(filter: filter, configuration: config, delegate: session)
        session.stream = stream
        do {
            try stream.addStreamOutput(session, type: .screen, sampleHandlerQueue: session.writerQueue)
            try stream.addStreamOutput(session, type: .audio, sampleHandlerQueue: session.writerQueue)
            if #available(macOS 15.0, *), options.microphone {
                try? stream.addStreamOutput(session, type: .microphone, sampleHandlerQueue: session.writerQueue)
            }
            try await stream.startCapture()
        } catch {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: options.outputURL)
            throw error
        }
        return session
    }

    private init(
        writer: AVAssetWriter,
        videoInput: AVAssetWriterInput,
        audioInput: AVAssetWriterInput?,
        micInput: AVAssetWriterInput?,
        outputURL: URL,
        width: Int,
        height: Int,
        onDeath: @escaping DeathHandler
    ) {
        self.writer = writer
        self.videoInput = videoInput
        self.audioInput = audioInput
        self.micInput = micInput
        self.outputURL = outputURL
        self.width = width
        self.height = height
        self.onDeath = onDeath
        super.init()
    }

    func pause() {
        writerQueue.sync {
            if pausedAt == nil { pausedAt = hostNow() }
        }
    }

    func resume() {
        writerQueue.sync {
            if let start = pausedAt {
                gaps.append((start, hostNow()))
                pausedAt = nil
            }
        }
    }

    /// Stop the stream and finish the file. Safe to call more than once and
    /// from more than one place (Stop, the stream dying, the app going
    /// away): every caller waits on the same finish.
    func finish() async throws {
        let task: Task<Void, Error> = finishLock.withLock {
            if let running = finishing { return running }
            let fresh = Task { try await self.finalise() }
            finishing = fresh
            return fresh
        }
        try await task.value
    }

    private func finalise() async throws {
        // A stream that already stopped on its own throws here; the file
        // still needs finishing, so that is not fatal.
        try? await stream?.stopCapture()
        let outcome: Result<Void, Error> = await withCheckedContinuation { cont in
            writerQueue.async {
                self.closed = true
                guard self.sessionStarted else {
                    self.writer.cancelWriting()
                    try? FileManager.default.removeItem(at: self.outputURL)
                    cont.resume(returning: .failure(CaptureError.writerFailed("The recording stopped before anything was captured.")))
                    return
                }
                guard self.writer.status == .writing else {
                    let message = self.writer.error?.localizedDescription ?? "The recording could not be saved."
                    cont.resume(returning: .failure(CaptureError.writerFailed(message)))
                    return
                }
                let end = self.endTime()
                self.appendTailFrame(at: end)
                self.writer.endSession(atSourceTime: end)
                self.videoInput.markAsFinished()
                self.audioInput?.markAsFinished()
                self.micInput?.markAsFinished()
                self.writer.finishWriting {
                    if self.writer.status == .completed {
                        cont.resume(returning: .success(()))
                    } else {
                        let message = self.writer.error?.localizedDescription ?? "The recording could not be saved."
                        cont.resume(returning: .failure(CaptureError.writerFailed(message)))
                    }
                }
            }
        }
        try outcome.get()
    }

    /// Discard the recording.
    func cancel() {
        stream?.stopCapture { _ in }
        writerQueue.sync {
            self.closed = true
            if self.writer.status == .writing {
                self.writer.cancelWriting()
            }
        }
        try? FileManager.default.removeItem(at: outputURL)
    }

    /// Where the timeline ends: now, or where the pause began, minus every
    /// pause, and never before the last frame.
    private func endTime() -> CMTime {
        var end = pausedAt ?? hostNow()
        for gap in gaps {
            end = end - (gap.end - gap.start)
        }
        if lastVideoTime.isValid, CMTimeCompare(end, lastVideoTime) < 0 {
            end = lastVideoTime
        }
        return end
    }

    /// ScreenCaptureKit sends no new frame while the screen is still, so the
    /// last picture is repeated at the end: the video then lasts as long as
    /// the recording instead of stopping at the last change.
    private func appendTailFrame(at end: CMTime) {
        guard let last = lastVideo, lastVideoTime.isValid,
              CMTimeCompare(end, lastVideoTime) > 0,
              videoInput.isReadyForMoreMediaData,
              let tail = shifted(last, by: lastVideoTime - end)
        else { return }
        if videoInput.append(tail) {
            lastVideoTime = end
        }
    }

    /// Where a sample lands on the recording's timeline, and by how much it
    /// was moved; nil for a sample that falls inside a pause.
    private func place(_ pts: CMTime) -> (time: CMTime, offset: CMTime)? {
        if let start = pausedAt, CMTimeCompare(pts, start) >= 0 { return nil }
        var offset = CMTime.zero
        for gap in gaps {
            if CMTimeCompare(pts, gap.end) >= 0 {
                offset = offset + (gap.end - gap.start)
            } else if CMTimeCompare(pts, gap.start) >= 0 {
                return nil
            }
        }
        return (pts - offset, offset)
    }

    /// The writer refused a sample: it has failed and will take nothing more.
    /// Report it now, not at Stop.
    private func writerFailed() {
        guard !deathReported else { return }
        deathReported = true
        closed = true
        let message = writer.error?.localizedDescription ?? "The recording could not be written."
        FileHandle.standardError.write(Data("writer failed: \(message)\n".utf8))
        onDeath(self, message)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !closed, CMSampleBufferIsValid(sampleBuffer) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard pts.isValid, let placed = place(pts) else { return }
        switch type {
        case .screen:
            guard isCompleteFrame(sampleBuffer) else { return }
            if !sessionStarted {
                writer.startSession(atSourceTime: placed.time)
                sessionStarted = true
            }
            if lastVideoTime.isValid, CMTimeCompare(placed.time, lastVideoTime) <= 0 { return }
            // Real time: a frame the encoder cannot take now is dropped.
            guard videoInput.isReadyForMoreMediaData, let buffer = shifted(sampleBuffer, by: placed.offset) else { return }
            if videoInput.append(buffer) {
                lastVideo = buffer
                lastVideoTime = placed.time
            } else {
                writerFailed()
            }
        case .audio:
            appendAudio(sampleBuffer, to: audioInput, placed: placed, lastEnd: &lastAudioEnd)
        case .microphone:
            appendAudio(sampleBuffer, to: micInput, placed: placed, lastEnd: &lastMicEnd)
        @unknown default:
            break
        }
    }

    private func appendAudio(
        _ sampleBuffer: CMSampleBuffer,
        to input: AVAssetWriterInput?,
        placed: (time: CMTime, offset: CMTime),
        lastEnd: inout CMTime
    ) {
        // Sound starts with the first picture.
        guard sessionStarted, let input else { return }
        // A buffer that straddled a pause's start overlaps the first one after
        // it once the pause is cut out; drop the overlap rather than write
        // audio that runs backwards.
        let slack = CMTime(value: 1, timescale: 1000)
        if lastEnd.isValid, CMTimeCompare(placed.time, lastEnd - slack) < 0 { return }
        guard input.isReadyForMoreMediaData, let buffer = shifted(sampleBuffer, by: placed.offset) else { return }
        if input.append(buffer) {
            let duration = CMSampleBufferGetDuration(sampleBuffer)
            lastEnd = duration.isValid ? placed.time + duration : placed.time
        } else {
            writerFailed()
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let message = error.localizedDescription
        FileHandle.standardError.write(Data("stream stopped: \(message)\n".utf8))
        writerQueue.async {
            guard !self.deathReported, !self.closed else { return }
            self.deathReported = true
            self.onDeath(self, message)
        }
    }
}
