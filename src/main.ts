import m from "mithril";
import { App, Gif, Recording, RenderOptions } from "./types";
import PlayView from "./views/play";
import PreviewView from "./views/preview";
import RecordView from "./views/record";
import RenderView from "./views/render";
import StartView from "./views/start";

declare global {
  interface MediaDevices {
    getDisplayMedia(opts: { video: { width: number; height: number } }): MediaStream;
  }
}

const FPS = 12;

type State =
  | { name: "start" }
  | { name: "playing"; gif: Gif; recording: Recording; renderOptions: RenderOptions }
  | { name: "recording"; captureStream: MediaStream; micStream: MediaStream | null }
  | { name: "previewing"; recording: Recording; renderOptions?: RenderOptions }
  | { name: "rendering"; recording: Recording; renderOptions: RenderOptions };

function assertState<T extends State["name"], E extends T>(actual: T, expected: E): asserts actual is E {
  if (actual !== expected) {
    throw new Error("Invalid state");
  }
}

class Main implements App {
  readonly frameLength = Math.floor(1000 / FPS);
  micEnabled = false;

  private _state: State = { name: "start" };

  private get state(): State {
    return this._state;
  }

  private set state(state: State) {
    this.cleanupState(this._state, state);
    this._state = state;
    m.redraw();
  }

  private cleanupState(oldState: State, newState: State): void {
    if (oldState.name === "playing" && oldState.gif !== (newState.name === "playing" ? newState.gif : undefined)) {
      // Revoke before publishing the next state so Mithril never keeps a stale object URL alive across redraws.
      URL.revokeObjectURL(oldState.gif.url);
    }

    if ("recording" in oldState && newState.name === "start") {
      oldState.recording.frames.length = 0;
    }
  }

  constructor() {
    window.onbeforeunload = () => {
      if (this.state.name === "recording") {
        return "";
      }
      return null;
    };
  }

  view() {
    return m(
      "section",
      {
        id: "app",
        class: this.state.name === "start" ? "home" : "",
      },
      [
        m("section", { id: "app-body" }, [
          m("h1", [m("span", { class: "gif" }, "gif"), m("span", { class: "cap" }, "frey")]),
          this.body(),
        ]),
        m("footer", { id: "app-footer" }, [
          m("span.left", [
            m("a", { href: "https://github.com/terpjwu1/giffrey" }, [
              m("img", {
                alt: "GitHub",
                src: "https://icongr.am/octicons/mark-github.svg?size=18&color=9e9e9e",
              }),
              " Giffrey",
            ]),
          ]),
          m("span.right", [
            "Screen to GIF/Video"
          ]),
        ]),
      ]
    );
  }

  body() {
    switch (this.state.name) {
      case "start":
        return m(StartView, { app: this });
      case "playing":
        return m(PlayView, { app: this, gif: this.state.gif, recording: this.state.recording, renderOptions: this.state.renderOptions });
      case "recording":
        return m(RecordView, { app: this, captureStream: this.state.captureStream, micStream: this.state.micStream });
      case "previewing":
        return m(PreviewView, { app: this, recording: this.state.recording, renderOptions: this.state.renderOptions });
      case "rendering":
        return m(RenderView, { app: this, recording: this.state.recording, renderOptions: this.state.renderOptions });
    }
  }

  async startRecording() {
    let micStream: MediaStream | null = null;

    if (this.micEnabled) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        micStream = null;
      }
    }

    try {
      const captureStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 9999 },
          height: { ideal: 9999 },
          frameRate: { ideal: 30 },
        } as any,
      });

      this.state = { name: "recording", captureStream, micStream };
      m.redraw.sync();
    } catch (err) {
      if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
      }
      console.error(err);
      return;
    }
  }

  stopRecording(recording: Recording) {
    this.state = { name: "previewing", recording };
  }

  startRendering(renderOptions: RenderOptions) {
    assertState(this.state.name, "previewing");
    this.state = { name: "rendering", recording: this.state.recording, renderOptions };
  }

  finishRendering(gif: Gif) {
    assertState(this.state.name, "rendering");
    this.state = { name: "playing", gif, recording: this.state.recording, renderOptions: this.state.renderOptions };
  }

  cancelRendering() {
    assertState(this.state.name, "rendering");
    this.state = { name: "previewing", recording: this.state.recording, renderOptions: this.state.renderOptions };
  }

  editGif() {
    assertState(this.state.name, "playing");
    this.state = { name: "previewing", recording: this.state.recording, renderOptions: this.state.renderOptions };
  }

  discardGif() {
    if (!window.confirm("This will discard the current recording, are you sure you want to continue?")) {
      return;
    }

    this.state = { name: "start" };
  }
}

function main() {
  m.mount(document.getElementById("app-container")!, Main);
}

main();
