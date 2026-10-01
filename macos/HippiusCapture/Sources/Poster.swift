import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// `--poster <video> <seconds>...`: stills from a finished recording, for the
/// capture card's picture. Prints one JSON line and exits:
///
///   {"duration": 12.4, "frames": [{"time": 1.0, "jpeg": "<base64>"}, ...]}
///
/// One frame per asked time, in the order asked, each clamped into the
/// video (a time past the end is the last frame). A time the video cannot
/// give is left out. Rust picks which time to ask for and which still to
/// keep (`capture::poster`): it skips a black one. The picture is the file
/// itself, so the card shows exactly what viewers will see (the camera
/// bubble included, and the camera-only stage, which has no screen to take
/// a screenshot of).
func runPoster(arguments: [String]) {
    guard let at = arguments.firstIndex(of: "--poster"), arguments.index(after: at) < arguments.endIndex else {
        print(jsonPosterLine(duration: 0, frames: []))
        return
    }
    let path = arguments[arguments.index(after: at)]
    let times = arguments[arguments.index(at, offsetBy: 2)...].compactMap { Double($0) }
    let result = pumpUntilDone(timeout: 10) { try await posterFrames(url: URL(fileURLWithPath: path), times: times) }
    switch result {
    case let .success(out)?:
        print(jsonPosterLine(duration: out.duration, frames: out.frames))
    case let .failure(error)?:
        FileHandle.standardError.write(Data("poster: \(error)\n".utf8))
        print(jsonPosterLine(duration: 0, frames: []))
    case nil:
        FileHandle.standardError.write(Data("poster: timed out\n".utf8))
        print(jsonPosterLine(duration: 0, frames: []))
    }
    fflush(stdout)
}

/// The longest edge of a still: twice the card's picture, so it stays crisp
/// on Retina after Rust scales it to the card.
let posterLongEdge: CGFloat = 1120

/// `time` inside a video `duration` long: never negative, and never past the
/// last frame (a request at or past the end returns nothing on some files).
func clampedPosterTime(_ time: Double, duration: Double) -> Double {
    guard time.isFinite else { return 0 }
    let last = max(0, duration - 0.1)
    return min(max(0, time), last)
}

private func posterFrames(url: URL, times: [Double]) async throws -> (duration: Double, frames: [(Double, String)]) {
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    let generator = AVAssetImageGenerator(asset: asset)
    // Upright as played, and small: the card needs a picture, not the file.
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: posterLongEdge, height: posterLongEdge)
    // A nearby frame is as good as the exact one, and much faster to reach.
    let tolerance = CMTime(seconds: 0.25, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance
    var frames: [(Double, String)] = []
    for asked in times {
        let time = clampedPosterTime(asked, duration: duration.isFinite ? duration : 0)
        guard let image = try? await generator.image(at: CMTime(seconds: time, preferredTimescale: 600)).image,
              let jpeg = jpegData(image)
        else { continue }
        frames.append((time, jpeg.base64EncodedString()))
    }
    return (duration.isFinite ? duration : 0, frames)
}

private func jpegData(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? data as Data : nil
}

private func jsonPosterLine(duration: Double, frames: [(Double, String)]) -> String {
    let object: [String: Any] = [
        "duration": duration,
        "frames": frames.map { ["time": $0.0, "jpeg": $0.1] },
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8)
    else { return "{\"duration\":0,\"frames\":[]}" }
    return text
}
