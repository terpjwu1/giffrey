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

    video.srcObject = combinedStream;
    this.displayCaptureInfo = await getDisplayCaptureInfo();

    const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;

    const worker = new Worker("/workers/ticker.js");
    worker.postMessage(this.app.frameLength);
    worker.onmessage = () => {
      if (video.videoWidth === 0) {
        return;
      }

      const first = this.startTime === 0;

      if (first) {
        const track = this.captureStream.getVideoTracks()[0];
        const settings = track?.getSettings();
        const sourceWidth = settings?.width || video.videoWidth;
        const sourceHeight = settings?.height || video.videoHeight;
        const dimensions = calculateCaptureDimensions(sourceWidth, sourceHeight, this.displayCaptureInfo);

        this.startTime = Date.now();
        this.width = dimensions.outputWidth;
        this.height = dimensions.outputHeight;
        canvas.width = dimensions.outputWidth;
        canvas.height = dimensions.outputHeight;

        // Electron 30/Chromium returns desktopCapturer getDisplayMedia streams in logical pixels on macOS Retina.
        // There is no supported Electron API or constraint to force physical-pixel capture, so preserve the
        // physical output dimensions by scaling the logical stream onto a device-pixel-sized canvas.
        ctx.imageSmoothingEnabled = !dimensions.upscaled;
      }

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
        m("canvas.hidden", { width: 640, height: 480 }),
        m("video.hidden", { autoplay: true, playsinline: true, muted: true }),
      ]),
    ];
  }

  private async stopRecording(): Promise<void> {
    if (this.videoRecorder) {
      await this.videoRecorder.stop();
    }
    const videoBlob = this.videoRecorder ? this.videoRecorder.getBlob() : null;
    const durationMs = this.frames.length > 0
      ? this.frames[this.frames.length - 1].timestamp
      : 0;
    console.log('[giffrey] stopRecording:', { videoBlob: videoBlob?.size, frames: this.frames.length, hasAudio: this.hasAudio, durationMs });
    this.app.stopRecording({
      width: this.width,
      height: this.height,
      frames: this.frames,
      videoBlob,
      tempFilePath: this.videoRecorder?.getTempFilePath() ?? undefined,
      hasAudio: this.hasAudio,
      durationMs,
    });
  }
}
