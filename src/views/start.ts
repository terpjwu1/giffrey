import m from "mithril";
import { App } from "../types";
import Button from "../components/button";
import View from "../components/view";

const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

interface StartViewAttrs {
  readonly app: App;
}

export default class StartView implements m.ClassComponent<StartViewAttrs> {
  private readonly app: App;
  private cameraStream: MediaStream | null = null;
  private dragging = false;
  private dragOffset = { x: 0, y: 0 };
  private previewEl: HTMLElement | null = null;

  constructor(vnode: m.CVnode<StartViewAttrs>) {
    this.app = vnode.attrs.app;
  }

  async oncreate(vnode: m.VnodeDOM<StartViewAttrs, this>) {
    this.previewEl = vnode.dom.querySelector(".screen-preview") as HTMLElement;

    document.addEventListener("mousemove", this.onMouseMove);
    document.addEventListener("mouseup", this.onMouseUp);

    if (this.app.cameraEnabled) {
      await this.startCamera(vnode.dom);
    }
  }

  onbeforeremove(): void {
    document.removeEventListener("mousemove", this.onMouseMove);
    document.removeEventListener("mouseup", this.onMouseUp);
    this.stopCamera();
  }

  private async startCamera(dom: Element): Promise<void> {
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 320 } },
      });
      const video = dom.querySelector(".face-bubble video") as HTMLVideoElement;
      if (video) {
        video.srcObject = this.cameraStream;
      }
      m.redraw();
    } catch {
      this.cameraStream = null;
    }
  }

  private stopCamera(): void {
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(t => t.stop());
      this.cameraStream = null;
    }
  }

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.dragging || !this.previewEl) return;
    const rect = this.previewEl.getBoundingClientRect();
    const bubbleRadius = 50;
    const halfNormX = bubbleRadius / rect.width;
    const halfNormY = bubbleRadius / rect.height;
    let nx = (e.clientX - rect.left) / rect.width;
    let ny = (e.clientY - rect.top) / rect.height;
    nx = Math.max(halfNormX, Math.min(1 - halfNormX, nx));
    ny = Math.max(halfNormY, Math.min(1 - halfNormY, ny));
    this.app.cameraX = Math.round(nx * 100) / 100;
    this.app.cameraY = Math.round(ny * 100) / 100;
    m.redraw();
  };

  private onMouseUp = (): void => {
    this.dragging = false;
  };

  private onBubbleMouseDown = (e: MouseEvent): void => {
    if (!this.app.cameraEnabled) return;
    this.dragging = true;
    e.preventDefault();
  };

  private async onCameraToggle(dom: Element): Promise<void> {
    this.app.cameraEnabled = !this.app.cameraEnabled;
    if (this.app.cameraEnabled) {
      await this.startCamera(dom);
    } else {
      this.stopCamera();
    }
    m.redraw();
  }

  view(vnode: m.VnodeDOM<StartViewAttrs, this>) {
    const bubbleSize = 100;
    const cx = (this.app.cameraX ?? 0.85) * 100;
    const cy = (this.app.cameraY ?? 0.80) * 100;

    return m(View, [
      m(".screen-preview", [
        m(".screen-preview-label", "Screen Preview"),
        m(".face-bubble", {
          class: this.app.cameraEnabled ? "" : "disabled",
          style: {
            width: `${bubbleSize}px`,
            height: `${bubbleSize}px`,
            left: `calc(${cx}% - ${bubbleSize / 2}px)`,
            top: `calc(${cy}% - ${bubbleSize / 2}px)`,
          },
          onmousedown: this.onBubbleMouseDown,
        }, [
          m("video", { autoplay: true, playsinline: true, muted: true }),
          !this.cameraStream ? m(".face-bubble-placeholder", "👤") : null,
        ]),
      ]),
      m(".camera-controls", [
        m("label.camera-toggle", [
          m("input[type=checkbox]", {
            checked: this.app.cameraEnabled,
            onchange: () => this.onCameraToggle(vnode.dom),
          }),
          " Face bubble",
        ]),
        m("label.mic-toggle", [
          m("input[type=checkbox]", {
            checked: this.app.micEnabled,
            onchange: (e: Event) => {
              this.app.micEnabled = (e.target as HTMLInputElement).checked;
            },
          }),
          " Microphone",
        ]),
      ]),
      isMobile ? m("p", "Sorry, mobile does not support screen recording.") : undefined,
      isMobile
        ? undefined
        : m(Button, {
            label: "Start Recording",
            icon: "play",
            onclick: () => {
              this.stopCamera();
              this.app.startRecording();
            },
            primary: true,
          }),
    ]);
  }
}
