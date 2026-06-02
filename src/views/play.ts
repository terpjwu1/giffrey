import m from "mithril";
import { App, Gif, Recording, RenderOptions } from "../types";
import Button from "../components/button";
import Timer from "../components/timer";
import View from "../components/view";

function humanSize(size: number): string {
  if (size < 1024) {
    return "1 KB";
  }

  size = Math.round(size / 1024);
  return size < 1024 ? `${size} KB` : `${Math.floor((size / 1024) * 100) / 100} MB`;
}

interface PlayViewAttrs {
  readonly app: App;
  readonly gif: Gif;
  readonly recording: Recording;
  readonly renderOptions: RenderOptions;
}

function pad(value: number, digits: number): string {
  return String(value).padStart(digits, "0");
}

export default class PlayView implements m.ClassComponent<PlayViewAttrs> {
  private readonly app: App;
  private readonly gif: Gif;
  private readonly recording: Recording;
  private readonly renderOptions: RenderOptions;

  private mp4Exporting = false;
  private mp4Progress = 0;
  private mp4Error: string | null = null;
  private cleanupProgress: (() => void) | null = null;

  constructor(vnode: m.CVnode<PlayViewAttrs>) {
    this.app = vnode.attrs.app;
    this.gif = vnode.attrs.gif;
    this.recording = vnode.attrs.recording;
    this.renderOptions = vnode.attrs.renderOptions;
  }

  private async saveGif(): Promise<void> {
    const giffrey = (window as any).giffrey;
    if (giffrey) {
      const arrayBuffer = await this.gif.blob.arrayBuffer();
      await giffrey.saveGif(arrayBuffer);
    }
  }

  private async saveMp4(): Promise<void> {
    const giffrey = (window as any).giffrey;
    if (!giffrey || !this.recording.videoBlob) return;

    this.mp4Exporting = true;
    this.mp4Progress = 0;
    this.mp4Error = null;
    m.redraw();

    try {
      this.cleanupProgress = giffrey.onMp4ExportProgress((progress: { ratio: number }) => {
        this.mp4Progress = progress.ratio;
        m.redraw();
      });

      const now = new Date();
      const filename = `Recording ${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(
        now.getDate(), 2
      )} at ${pad(now.getHours(), 2)}.${pad(now.getMinutes(), 2)}.${pad(now.getSeconds(), 2)}.mp4`;

      const webm = await this.recording.videoBlob.arrayBuffer();
      const frames = this.recording.frames;
      const trimStartMs = frames[this.renderOptions.trim.start]?.timestamp ?? 0;
      const trimEndMs = frames[this.renderOptions.trim.end]?.timestamp ?? this.recording.durationMs;

      const result = await giffrey.exportMp4({
        webm,
        trim: { startMs: trimStartMs, endMs: trimEndMs },
        crop: this.renderOptions.crop,
        source: {
          width: this.recording.width,
          height: this.recording.height,
          durationMs: this.recording.durationMs,
          hasAudio: this.recording.hasAudio,
        },
        suggestedFilename: filename,
      });

      if (!result.ok && result.error.code !== 'cancelled') {
        this.mp4Error = result.error.message;
      }
    } catch (err: any) {
      this.mp4Error = err.message || 'MP4 export failed unexpectedly';
    } finally {
      if (this.cleanupProgress) {
        this.cleanupProgress();
        this.cleanupProgress = null;
      }
      this.mp4Exporting = false;
      m.redraw();
    }
  }

  private cancelMp4(): void {
    const giffrey = (window as any).giffrey;
    if (giffrey) {
      giffrey.cancelMp4Export();
    }
  }

  onbeforeremove(): void {
    if (this.cleanupProgress) {
      this.cleanupProgress();
    }
    URL.revokeObjectURL(this.gif.url);
  }

  view() {
    const now = new Date();
    const download = `Recording ${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(
      now.getDate(),
      2
    )} at ${pad(now.getHours(), 2)}.${pad(now.getMinutes(), 2)}.${pad(now.getSeconds(), 2)}.gif`;

    const actions = [
      m(Button, {
        label: "Save GIF",
        icon: "download",
        onclick: () => this.saveGif(),
        primary: true,
        disabled: this.mp4Exporting,
      }),
      m(Button, {
        label: this.recording.hasAudio ? "Save MP4 ♪" : "Save MP4",
        icon: "video",
        iconset: "octicons",
        onclick: () => this.saveMp4(),
        disabled: this.mp4Exporting || !this.recording.videoBlob,
      }),
      m(Button, {
        label: "Edit",
        icon: "pencil",
        onclick: () => this.app.editGif(),
        disabled: this.mp4Exporting,
      }),
      m(Button, {
        label: "Discard",
        icon: "trashcan",
        onclick: () => this.app.discardGif(),
        disabled: this.mp4Exporting,
      }),
    ];

    return [
      m(
        View,
        { actions },
        m(".recording-card", [
          this.mp4Exporting
            ? m(".mp4-progress", [
                m("progress", { max: "1", value: this.mp4Progress, title: "Exporting MP4..." },
                  `Exporting: ${Math.floor(this.mp4Progress * 100)}%`),
                m(Button, { label: "Cancel", icon: "square-fill", onclick: () => this.cancelMp4() }),
              ])
            : null,
          this.mp4Error
            ? m(".mp4-error", [
                m("p.error-message", this.mp4Error),
                m(Button, { label: "Dismiss", icon: "x", onclick: () => { this.mp4Error = null; } }),
              ])
            : null,
          m(
            "a",
            {
              href: this.gif.url,
              download,
              target: "_blank",
            },
            [m("img.recording", { src: this.gif.url })]
          ),
          m("footer", [
            m(Timer, { duration: this.gif.duration }),
            m("span.tag.is-small", [
              m(
                "a.recording-detail",
                {
                  href: this.gif.url,
                  download,
                  target: "_blank",
                },
                [
                  m("img", {
                    src: "https://icongr.am/octicons/download.svg?size=16&color=333333",
                  }),
                  humanSize(this.gif.size),
                ]
              ),
            ]),
          ]),
        ])
      ),
    ];
  }
}
