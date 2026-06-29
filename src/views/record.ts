import m from "mithril";
import { App, Frame } from "../types";
import { createVideoRecorder, VideoRecording } from "../video-recorder";
import { buildCanvasRecordingStream, buildCombinedStream } from "../mic-utils";
import { DisplayCaptureInfo, calculateCaptureDimensions, getDisplayCaptureInfo } from "../capture-resolution";
import Button from "../components/button";
import Timer from "../components/timer";
import View from "../components/view";

interface RecordViewAttrs {
  readonly app: App;
  readonly captureStream: MediaStream;
  readonly micStream: MediaStream | null;
}

const MAX_GIF_FRAMES = 600;
const GIF_SCALE = 0.25;
const CAPTURE_READY_TIMEOUT_MS = 2000;
const CAPTURE_PERMISSION_ERROR = "Screen capture permission may be missing — please restart the app after granting permission in System Settings.";

export default class RecordView implements m.ClassComponent<RecordViewAttrs> {
  private readonly app: App;
  private readonly captureStream: MediaStream;
  private readonly micStream: MediaStream | null;

  private startTime: number = 0;
  private width: number = 0;
  private height: number = 0;
  private displayCaptureInfo: DisplayCaptureInfo = { scaleFactor: 1 };
  private frames: Frame[] = [];
  private hasAudio: boolean = false;
  private videoRecorder: VideoRecording | undefined;
  private recordingStream: MediaStream | undefined;
  private useNativeCapture = false;
  private nativeCaptureOutputPath: string | null = null;
  private micRecorder: MediaRecorder | null = null;
  private micChunks: Blob[] = [];
  private webcamRecorder: MediaRecorder | null = null;
  private webcamChunks: Blob[] = [];
  private webcamStream: MediaStream | null = null;
  private videoMetadataLoaded = false;
  private captureReadyStartedAt = 0;
  private captureError: string | null = null;
  private _onbeforeremove: Function | undefined;

  constructor(vnode: m.CVnode<RecordViewAttrs>) {
    this.app = vnode.attrs.app;
    this.captureStream = vnode.attrs.captureStream;
    this.micStream = vnode.attrs.micStream;
  }

  async oncreate(vnode: m.VnodeDOM<RecordViewAttrs, this>) {
    const video: HTMLVideoElement = vnode.dom.getElementsByTagName("video")[0];
    const canvas: HTMLCanvasElement = vnode.dom.getElementsByTagName("canvas")[0];

    const { stream: combinedStream, hasAudio } = buildCombinedStream(this.captureStream, this.micStream);
    this.hasAudio = hasAudio;

    this.captureReadyStartedAt = Date.now();
    video.onloadedmetadata = () => {
      this.videoMetadataLoaded = true;
      console.log('[giffrey] capture video metadata loaded:', {
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        readyState: video.readyState,
        trackSettings: this.captureStream.getVideoTracks()[0]?.getSettings(),
      });
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        this.captureError = CAPTURE_PERMISSION_ERROR;
      } else {
        this.captureError = null;
      }
      m.redraw();
    };
    video.onerror = () => {
      console.error('[giffrey] capture video element failed to load:', video.error);
      this.captureError = CAPTURE_PERMISSION_ERROR;
      m.redraw();
    };
    video.srcObject = combinedStream;
    video.play().catch((err) => {
      console.error('[giffrey] capture video play failed:', err);
      this.captureError = CAPTURE_PERMISSION_ERROR;
      m.redraw();
    });
    this.displayCaptureInfo = await getDisplayCaptureInfo();

    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;

    // Start native capture in background — don't block worker/recording
    const giffrey = (window as any).giffrey;
    if (giffrey?.isNativeCaptureAvailable) {
      giffrey.isNativeCaptureAvailable().then(async ({ available }: { available: boolean }) => {
        if (!available) return;
        const hasMic = !!(this.micStream && this.micStream.getAudioTracks().length > 0);
        const result = await giffrey.startNativeCapture({
          fps: 15,
          includeAudio: !hasMic,
          includeMic: hasMic,
          enableCamera: this.app.cameraEnabled || false,
          cameraX: this.app.cameraX ?? 0.85,
          cameraY: this.app.cameraY ?? 0.80,
          cameraSize: this.app.cameraSize ?? 300,
        });
        if (result.ok) {
          this.useNativeCapture = true;
          this.nativeCaptureOutputPath = result.outputPath;
          this.width = result.width;
          this.height = result.height;
        }
      }).catch(() => {});
    }

    // Record webcam separately for FFmpeg overlay fallback (when native capture unavailable)
    if (this.app.cameraEnabled && !this.useNativeCapture) {
      try {
        this.webcamStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 480 } },
        });
        this.webcamRecorder = new MediaRecorder(this.webcamStream, { mimeType: "video/webm;codecs=vp8" });
        this.webcamRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) this.webcamChunks.push(e.data);
        };
        this.webcamRecorder.start();
      } catch {
        this.webcamStream = null;
      }
    }

    const worker = new Worker("/workers/ticker.js");
    worker.postMessage(this.app.frameLength);
    worker.onmessage = () => {
      if (!this.videoMetadataLoaded || video.videoWidth === 0 || video.videoHeight === 0) {
        if (!this.captureError && Date.now() - this.captureReadyStartedAt > CAPTURE_READY_TIMEOUT_MS) {
          console.error('[giffrey] capture video stayed zero-size after metadata wait:', {
            metadataLoaded: this.videoMetadataLoaded,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            readyState: video.readyState,
            trackSettings: this.captureStream.getVideoTracks()[0]?.getSettings(),
          });
          this.captureError = CAPTURE_PERMISSION_ERROR;
          m.redraw();
        }
        return;
      }

      this.captureError = null;
      const first = this.startTime === 0;

      if (first) {
        this.startTime = Date.now();

        if (this.useNativeCapture) {
          // GIF preview frames at quarter logical resolution
          const gifWidth = Math.round(video.videoWidth * GIF_SCALE);
          const gifHeight = Math.round(video.videoHeight * GIF_SCALE);
          canvas.width = gifWidth;
          canvas.height = gifHeight;
        } else {
          // Fallback: canvas upscaling path
          const track = this.captureStream.getVideoTracks()[0];
          const settings = track?.getSettings();
          const sourceWidth = settings?.width || video.videoWidth;
          const sourceHeight = settings?.height || video.videoHeight;
          const dimensions = calculateCaptureDimensions(sourceWidth, sourceHeight, this.displayCaptureInfo);

          this.width = dimensions.outputWidth;
          this.height = dimensions.outputHeight;
          canvas.width = dimensions.outputWidth;
          canvas.height = dimensions.outputHeight;
          ctx.imageSmoothingEnabled = !dimensions.upscaled;
        }
      }

      // For native capture: only capture GIF frames (bounded)
      if (this.useNativeCapture) {
        if (this.frames.length >= MAX_GIF_FRAMES) return;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        this.frames.push({
          imageData,
          timestamp: first ? 0 : Date.now() - this.startTime,
        });
        return;
      }

      // Fallback path: canvas upscaling + MediaRecorder
      if (!this.videoRecorder) {
        const canvasStream = canvas.captureStream(Math.max(1, Math.round(1000 / this.app.frameLength)));
        const { stream: recordingStream, hasAudio: recordingHasAudio } = buildCanvasRecordingStream(canvasStream, this.micStream);
        this.recordingStream = recordingStream;
        this.hasAudio = recordingHasAudio;
        this.videoRecorder = createVideoRecorder(recordingStream, recordingHasAudio);
        this.videoRecorder.start();
      }

      ctx.drawImage(video, 0, 0, this.width, this.height);
      const imageData = ctx.getImageData(0, 0, this.width, this.height);

      this.frames.push({
        imageData,
        timestamp: first ? 0 : Date.now() - this.startTime,
      });
    };

    const redrawInterval = setInterval(() => m.redraw(), this.app.frameLength);

    const track = this.captureStream.getVideoTracks()[0];
    const endedListener = () => this.stopRecording();
    track.addEventListener("ended", endedListener);

    this._onbeforeremove = () => {
      worker.terminate();
      clearInterval(redrawInterval);
      track.removeEventListener("ended", endedListener);
      combinedStream.getTracks().forEach(t => t.stop());
      this.recordingStream?.getVideoTracks().forEach(t => t.stop());
      video.onloadedmetadata = null;
      video.onerror = null;
      video.srcObject = null;
    };

    m.redraw();
  }

  onbeforeremove(): void {
    this._onbeforeremove && this._onbeforeremove();
  }

  view() {
    return [
      m(View, [
        m("p", [
          m(Timer, {
            duration: this.startTime === 0 ? 0 : Date.now() - this.startTime,
          }),
        ]),
        m(Button, {
          label: "Stop Recording",
          icon: "square-fill",
          onclick: () => this.stopRecording(),
        }),
        this.captureError ? m("p.text-error", this.captureError) : null,
        m("canvas.hidden", { width: 640, height: 480 }),
        m("video", {
          autoplay: true,
          playsinline: true,
          muted: true,
          style: {
            position: "absolute",
            left: "-9999px",
            top: "0",
            width: "1px",
            height: "1px",
            opacity: "0",
            pointerEvents: "none",
          },
        }),
      ]),
    ];
  }

  private async stopRecording(): Promise<void> {
    let videoBlob: Blob | null = null;
    let tempFilePath: string | undefined;

    if (this.useNativeCapture) {
      const giffrey = (window as any).giffrey;
      const result = await giffrey.stopNativeCapture();
      if (result.ok) {
        tempFilePath = this.nativeCaptureOutputPath || undefined;
      }
      // Stop mic recorder
      if (this.micRecorder && this.micRecorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          this.micRecorder!.onstop = () => resolve();
          this.micRecorder!.stop();
        });
      }
    } else {
      if (this.videoRecorder) {
        await this.videoRecorder.stop();
      }
      videoBlob = this.videoRecorder ? this.videoRecorder.getBlob() : null;
      tempFilePath = this.videoRecorder?.getTempFilePath() ?? undefined;
    }

    // Stop webcam recording
    let webcamBlob: Blob | null = null;
    if (this.webcamRecorder && this.webcamRecorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        this.webcamRecorder!.onstop = () => resolve();
        this.webcamRecorder!.stop();
      });
      if (this.webcamChunks.length > 0) {
        webcamBlob = new Blob(this.webcamChunks, { type: "video/webm" });
      }
    }
    if (this.webcamStream) {
      this.webcamStream.getTracks().forEach(t => t.stop());
      this.webcamStream = null;
    }

    const durationMs = this.frames.length > 0
      ? this.frames[this.frames.length - 1].timestamp
      : 0;
    console.log('[giffrey] stopRecording:', {
      native: this.useNativeCapture,
      videoBlob: videoBlob?.size,
      webcamBlob: webcamBlob?.size,
      frames: this.frames.length,
      hasAudio: this.hasAudio,
      durationMs,
      tempFilePath,
    });
    this.app.stopRecording({
      width: this.width,
      height: this.height,
      frames: this.frames,
      videoBlob,
      tempFilePath,
      hasAudio: this.hasAudio,
      durationMs,
      isNativeCapture: this.useNativeCapture,
      webcamOverlay: webcamBlob ? {
        blob: webcamBlob,
        x: this.app.cameraX ?? 0.85,
        y: this.app.cameraY ?? 0.80,
        size: this.app.cameraSize ?? 300,
      } : undefined,
    });
  }
}
