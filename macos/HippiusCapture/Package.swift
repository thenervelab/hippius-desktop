// swift-tools-version: 5.9
import Foundation
import PackageDescription

// A command-line tool has no bundle, so its Info.plist is linked into the
// binary's __TEXT,__info_plist section. AVFoundation reads it from there: it
// carries NSCameraUseContinuityCameraDeviceType, without which an iPhone is
// not offered as a Continuity Camera. Absolute, because the linker does not
// run in this directory.
let infoPlist = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("Info.plist")
    .path

let package = Package(
    name: "HippiusCapture",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "HippiusCapture",
            path: "Sources",
            linkerSettings: [
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist])
            ]
        )
    ]
)
