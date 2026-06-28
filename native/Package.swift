// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GiffreySCKCapture",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "giffrey-sck-capture",
            path: "Sources/GiffreySCKCapture",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
                .linkedFramework("VideoToolbox"),
            ]
        )
    ]
)
