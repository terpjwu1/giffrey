import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import VideoToolbox

class CaptureSession: NSObject, SCStreamOutput, AVCaptureAudioDataOutputSampleBufferDelegate {
    let serialQueue = DispatchQueue(label: "com.giffrey.capture")
    private let args: Args
    private var stream: SCStream?
    private var assetWriter: AVAssetWriter?
    private var videoInput: AVAssetWriterInput?
    private var pixelBufferAdaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var audioInput: AVAssetWriterInput?
    private var micSession: AVCaptureSession?
    private var micInput: AVAssetWriterInput?
    private var isShuttingDown = false
    private var startTime: CMTime?
    private var sessionStarted = false

    init(args: Args) {
        self.args = args
        super.init()
    }

    func start() async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.first else {
                writeStatus(["status": "error", "message": "No display found"])
                exit(1)
            }

            let config = SCStreamConfiguration()
            // display.width/height are logical; multiply by scaleFactor for physical pixels
            let scaleFactor = Int(NSScreen.main?.backingScaleFactor ?? 2)
            config.width = display.width * scaleFactor
            config.height = display.height * scaleFactor
            config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(args.fps))
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = true

            if args.captureAudio {
                config.capturesAudio = true
                config.sampleRate = 48000
                config.channelCount = 2
                config.excludesCurrentProcessAudio = true
            }

            let physicalWidth = display.width * scaleFactor
            let physicalHeight = display.height * scaleFactor
            let filter = SCContentFilter(display: display, excludingWindows: [])
            try setupAssetWriter(width: physicalWidth, height: physicalHeight, includeMic: args.captureMic)

            let scStream = SCStream(filter: filter, configuration: config, delegate: nil)
            try scStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: serialQueue)
            if args.captureAudio {
                try scStream.addStreamOutput(self, type: .audio, sampleHandlerQueue: serialQueue)
            }

            try await scStream.startCapture()
            self.stream = scStream

            // Start mic capture after SCStream is running
            if args.captureMic && micInput != nil {
                startMicSession()
            }

            writeStatus([
                "status": "recording",
                "width": physicalWidth,
                "height": physicalHeight,
            ])
        } catch {
            writeStatus(["status": "error", "message": error.localizedDescription])
            exit(1)
        }
    }

    private func setupAssetWriter(width: Int, height: Int, includeMic: Bool = false) throws {
        let url = URL(fileURLWithPath: args.outputPath)
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(url: url, fileType: .mp4)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 8_000_000,
                AVVideoMaxKeyFrameIntervalDurationKey: 2.0,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoAllowFrameReorderingKey: false,
            ] as [String: Any],
        ]
        let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        vInput.expectsMediaDataInRealTime = true

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: vInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ]
        )

        writer.add(vInput)
        self.videoInput = vInput
        self.pixelBufferAdaptor = adaptor

        if args.captureAudio {
            let audioSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 128_000,
            ]
            let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            aInput.expectsMediaDataInRealTime = true
            writer.add(aInput)
            self.audioInput = aInput
        }

        if includeMic {
            // Use 48kHz for AAC output — AVAssetWriter resamples from mic's native rate
            let micSettings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 128_000,
            ]
            let mInput = AVAssetWriterInput(mediaType: .audio, outputSettings: micSettings)
            mInput.expectsMediaDataInRealTime = true
            writer.add(mInput)
            self.micInput = mInput
        }

        self.assetWriter = writer
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !isShuttingDown else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

        switch type {
        case .screen:
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

            if startTime == nil {
                startTime = pts
                assetWriter?.startWriting()
                assetWriter?.startSession(atSourceTime: .zero)
                sessionStarted = true
            }

            let relativePTS = CMTimeSubtract(pts, startTime!)
            guard let input = videoInput, input.isReadyForMoreMediaData else { return }
            pixelBufferAdaptor?.append(pixelBuffer, withPresentationTime: relativePTS)

        case .audio:
            guard sessionStarted else { return }
            guard let input = audioInput, input.isReadyForMoreMediaData else { return }
            let relativePTS = CMTimeSubtract(pts, startTime!)
            if relativePTS.seconds < 0 { return }
            if let adjustedBuffer = adjustTimestamp(sampleBuffer, to: relativePTS) {
                input.append(adjustedBuffer)
            }

        @unknown default:
            break
        }
    }

    private func adjustTimestamp(_ buffer: CMSampleBuffer, to newPTS: CMTime) -> CMSampleBuffer? {
        var timing = CMSampleTimingInfo(
            duration: CMSampleBufferGetDuration(buffer),
            presentationTimeStamp: newPTS,
            decodeTimeStamp: .invalid
        )
        var newBuffer: CMSampleBuffer?
        CMSampleBufferCreateCopyWithNewTiming(
            allocator: nil,
            sampleBuffer: buffer,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleBufferOut: &newBuffer
        )
        return newBuffer
    }

    // MARK: - AVCaptureAudioDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !isShuttingDown, sessionStarted else { return }
        guard let input = micInput, input.isReadyForMoreMediaData else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let relativePTS = CMTimeSubtract(pts, startTime!)
        if relativePTS.seconds < 0 { return }
        if let adjusted = adjustTimestamp(sampleBuffer, to: relativePTS) {
            input.append(adjusted)
        }
    }

    // MARK: - Mic Capture

    private func getMicSampleRate() -> Double {
        guard let device = AVCaptureDevice.default(for: .audio) else { return 48000 }
        if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(device.activeFormat.formatDescription) {
            return asbd.pointee.mSampleRate
        }
        return 48000
    }

    private func startMicSession() {
        guard let device = AVCaptureDevice.default(for: .audio) else { return }
        let session = AVCaptureSession()
        guard let deviceInput = try? AVCaptureDeviceInput(device: device) else { return }
        session.addInput(deviceInput)

        let output = AVCaptureAudioDataOutput()
        output.setSampleBufferDelegate(self, queue: serialQueue)
        session.addOutput(output)

        session.startRunning()
        self.micSession = session
    }

    // MARK: - Shutdown

    func gracefulShutdown() {
        serialQueue.async { [self] in
            guard !isShuttingDown else { return }
            isShuttingDown = true

            let duration = startTime.map {
                CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), $0))
            } ?? 0

            micSession?.stopRunning()

            stream?.stopCapture { [self] _ in
                serialQueue.async { [self] in
                    videoInput?.markAsFinished()
                    audioInput?.markAsFinished()
                    micInput?.markAsFinished()

                    guard let writer = assetWriter, writer.status == .writing else {
                        writeStatus(["status": "error", "message": "Writer not in writing state"])
                        exit(1)
                    }

                    writer.finishWriting { [self] in
                        serialQueue.async { [self] in
                            if writer.status == .completed {
                                writeStatus(["status": "done", "duration": duration])
                                exit(0)
                            } else {
                                writeStatus(["status": "error", "message": writer.error?.localizedDescription ?? "unknown"])
                                exit(1)
                            }
                        }
                    }
                }
            }
        }
    }
}
