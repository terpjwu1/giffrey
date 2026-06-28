import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import VideoToolbox

struct Args {
    let outputPath: String
    let fps: Int
    let displayID: Int
    let captureAudio: Bool
    let captureMic: Bool
    let enableCamera: Bool
    let cameraX: Float
    let cameraY: Float
    let cameraSize: Int
}

func parseArgs() -> Args {
    var output = "/tmp/capture.mp4"
    var fps = 15
    var displayID = 0
    var audio = false
    var mic = false
    var camera = false
    var cameraX: Float = 0.85
    var cameraY: Float = 0.80
    var cameraSize = 300
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--output": i += 1; output = args[i]
        case "--fps": i += 1; fps = Int(args[i]) ?? 15
        case "--display": i += 1; displayID = Int(args[i]) ?? 0
        case "--audio": audio = true
        case "--mic": mic = true
        case "--camera": camera = true
        case "--camera-x": i += 1; cameraX = Float(args[i]) ?? 0.85
        case "--camera-y": i += 1; cameraY = Float(args[i]) ?? 0.80
        case "--camera-size": i += 1; cameraSize = Int(args[i]) ?? 300
        default: break
        }
        i += 1
    }
    return Args(outputPath: output, fps: fps, displayID: displayID, captureAudio: audio, captureMic: mic, enableCamera: camera, cameraX: cameraX, cameraY: cameraY, cameraSize: cameraSize)
}

func writeStatus(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write((str + "\n").data(using: .utf8)!)
    }
}

let args = parseArgs()
let session = CaptureSession(args: args)

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: session.serialQueue)
let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: session.serialQueue)
sigTermSource.setEventHandler { session.gracefulShutdown() }
sigIntSource.setEventHandler { session.gracefulShutdown() }
sigTermSource.resume()
sigIntSource.resume()

Task {
    await session.start()
}

RunLoop.main.run()
