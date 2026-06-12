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
}

func parseArgs() -> Args {
    var output = "/tmp/capture.mp4"
    var fps = 15
    var displayID = 0
    var audio = false
    var mic = false
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--output": i += 1; output = args[i]
        case "--fps": i += 1; fps = Int(args[i]) ?? 15
        case "--display": i += 1; displayID = Int(args[i]) ?? 0
        case "--audio": audio = true
        case "--mic": mic = true
        default: break
        }
        i += 1
    }
    return Args(outputPath: output, fps: fps, displayID: displayID, captureAudio: audio, captureMic: mic)
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
