# MP4 Export + Live Voice-Over Design

## Problem

Giffrey currently exports only GIF (via WASM encoder) and raw WebM (via MediaRecorder). Users need:
1. **MP4 export** — universally playable, smaller than GIF for longer recordings, embeddable everywhere
2. **Live voice-over** — record microphone audio simultaneously with screen capture for tutorials and walkthroughs

These features are tightly coupled: voice-over produces audio that needs a container format (MP4) to be useful.

## Use Cases

- **Quick demos**: Short screen recordings shared in Slack/PRs/docs (GIF or short MP4)
- **Tutorials**: Longer recordings with narration for onboarding and how-tos (MP4 with audio)

## Decision: Native `ffmpeg-static` (Approach B)

After a technical spike (see `docs/specs/2026-06-01-spike-findings.md`), we chose native FFmpeg over FFmpeg.wasm and direct MP4 MediaRecorder.

**Spike results that drove the decision:**
- Native FFmpeg transcodes 30s 720p VP9+Opus → H.264+AAC MP4 with trim+crop in **0.19 seconds** (7x realtime)
- FFmpeg.wasm requires SharedArrayBuffer/COOP/COEP changes to the `app://` protocol handler — added complexity for 2-3x slower performance
- Electron 30 does NOT support `video/mp4` MediaRecorder (Electron 42+ does — separate upgrade scope)
- `ffmpeg-static` is 43MB (comparable to FFmpeg.wasm's 31-62MB installed footprint)
- Fits existing architecture: main process already handles file I/O via IPC

**Alternatives evaluated and rejected:**
- **FFmpeg.wasm**: Viable but slower, requires protocol handler changes for SharedArrayBuffer
- **Direct MP4 MediaRecorder**: Not supported in Electron 30; even with upgrade, still needs FFmpeg for trim/crop

## Architecture

```
RECORDING (Renderer Process)
  ┌─────────────────────────────────────────────────┐
  │  getDisplayMedia() → screen video track          │
  │  getUserMedia({audio}) → mic audio track         │
  │                                                   │
  │  Combined MediaStream (video + audio)             │
  │       ↓                        ↓                  │
  │  MediaRecorder              Canvas frame          │
  │  (webm;vp9,opus)           capture (12 FPS)      │
  │       ↓                        ↓                  │
  │  WebM Blob               ImageData[] frames       │
  │  (on Recording)          (for GIF encoder)        │
  └─────────────────────────────────────────────────┘

EXPORT — GIF (Renderer Process, unchanged)
  ImageData[] → GifEncoder (WASM) → GIF Blob → save via IPC

EXPORT — MP4 (Main Process, new)
  ┌─────────────────────────────────────────────────┐
  │  Renderer sends: WebM ArrayBuffer + RenderOptions│
  │       ↓                                          │
  │  Main process:                                   │
  │    1. Show save dialog                           │
  │    2. Write WebM to temp file                    │
  │    3. Spawn ffmpeg-static:                       │
  │       -ss <startMs> -to <endMs>                  │
  │       -vf crop=<evenW>:<evenH>:<evenX>:<evenY>   │
  │       -c:v libx264 -pix_fmt yuv420p             │
  │       -c:a aac                                   │
  │       output.mp4                                 │
  │    4. Stream progress (parse stderr time=)       │
  │    5. Cleanup temp files                         │
  └─────────────────────────────────────────────────┘
```

## IPC Contract

### Preload API (exposed on `window.giffrey`)

```typescript
interface Mp4ExportRequest {
  webm: ArrayBuffer;
  trim: { startMs: number; endMs: number };
  crop: { left: number; top: number; width: number; height: number };
  source: { width: number; height: number; durationMs: number; hasAudio: boolean };
  suggestedFilename: string;
}

// Discriminated union — no invalid states
type Mp4ExportResult =
  | { ok: true; filePath: string; sizeBytes: number }
  | { ok: false; error: { code: "cancelled" | "ffmpeg_missing" | "transcode_failed" | "disk_full" | "write_failed"; message: string; recoverable: boolean } };

interface Mp4ExportProgress {
  phase: "preparing" | "transcoding" | "saving";
  ratio: number;  // 0-1
}

// Preload exposes:
exportMp4(request: Mp4ExportRequest): Promise<Mp4ExportResult>;
onMp4ExportProgress(callback: (progress: Mp4ExportProgress) => void): () => void;
cancelMp4Export(): Promise<void>;
```

**Single-flight constraint:** Only one MP4 export can be active at a time. `exportMp4()` rejects if one is already in progress. `cancelMp4Export()` always targets the active export (no ID needed). Progress events are only emitted for the active export.

### IPC Channels (main process)

- `mp4-export:start` — invoke: receives request, runs full pipeline, returns result
- `mp4-export:progress` — send: main → renderer progress events during transcode
- `mp4-export:cancel` — invoke: kills ffmpeg child process, cleans temp files

## Mic Recording

**Strategy:** Opt-in toggle on the start screen. Request mic BEFORE screen capture so permission denial doesn't disrupt an active recording.

```typescript
// 1. Request mic first (if enabled) — can fail gracefully before screen capture starts
let micStream: MediaStream | null = null;
if (micEnabled) {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    // Mic denied — continue without audio
    micStream = null;
  }
}

// 2. Request screen capture
const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { width: 9999, height: 9999 } });

// 3. Combine streams
const tracks = [...displayStream.getVideoTracks()];
if (micStream) {
  tracks.push(...micStream.getAudioTracks());
}
const combinedStream = new MediaStream(tracks);

// 4. Choose codec based on whether audio is present
const mimeType = micStream
  ? "video/webm;codecs=vp9,opus"
  : "video/webm;codecs=vp9";

const recorder = new MediaRecorder(combinedStream, { mimeType });
```

**Graceful degradation:** If mic permission is denied, record screen-only (current behavior). MP4 export still works — just without audio.

**Mic stream cleanup:** On stop, both the video track AND audio track must be stopped and removed. Update the `_onbeforeremove` in record.ts to stop all tracks on the combined stream:
```typescript
combinedStream.getTracks().forEach(track => track.stop());
video.srcObject = null;
```

**UI:** Mic toggle button on the start screen. During recording, show mic active/muted indicator. Mic state stored on `Recording` object (`hasAudio: boolean`).

## Export UI Location

**Decision:** MP4 export lives in the **play view** (`src/views/play.ts`), alongside the existing "Save GIF" button.

**Rationale:** The play view is the terminal state where the user has a completed GIF and can choose what to do with it. Adding "Save MP4" here means: "you've seen the preview, now choose your export format." The preview view owns trim/crop editing, not export actions.

The play view already has access to the full `Recording` (including `videoBlob`) and `RenderOptions` via state — these are passed through to the MP4 export IPC call.

## FFmpeg Binary Packaging

**Dev mode:** Resolve via `require('ffmpeg-static')` which returns the absolute path to the binary.

**Packaged mode:** electron-builder must include the binary in the `extraResources`:
```json
{
  "build": {
    "mac": {
      "extraResources": [{ "from": "node_modules/ffmpeg-static/ffmpeg", "to": "ffmpeg" }]
    },
    "win": {
      "extraResources": [{ "from": "node_modules/ffmpeg-static/ffmpeg.exe", "to": "ffmpeg.exe" }]
    }
  }
}
```

**Path resolution in main process:**
```typescript
const ffmpegBin = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffmpegPath = app.isPackaged
  ? path.join(process.resourcesPath, ffmpegBin)
  : require("ffmpeg-static");
```

**Platform binaries:** `ffmpeg-static` installs the correct arch binary via postinstall. CI builds for mac-arm64, mac-x64, and win-x64 each get the matching binary automatically.

**Notarization:** The bundled ffmpeg binary must be code-signed alongside the app. electron-builder signs all files in `extraResources` when `--mac --sign` is configured. Verify in Phase 0 that the DMG launches without Gatekeeper blocking ffmpeg execution.

## Type Changes Required

```typescript
// Add to src/types.d.ts:
interface Recording {
  width: number;
  height: number;
  frames: Frame[];
  videoBlob: Blob | null;
  hasAudio: boolean;      // NEW: true if mic was active during recording
  durationMs: number;     // NEW: total recording duration from first to last frame timestamp
}

// Add new file: src/mp4-export.d.ts (or extend types.d.ts)
// Contains Mp4ExportRequest, Mp4ExportResult, Mp4ExportProgress types

// Extend window.giffrey in src/types.d.ts:
interface GiffreyAPI {
  saveGif(blob: ArrayBuffer): Promise<string | null>;
  saveVideo(blob: ArrayBuffer): Promise<string | null>;
  exportMp4(request: Mp4ExportRequest): Promise<Mp4ExportResult>;
  onMp4ExportProgress(callback: (progress: Mp4ExportProgress) => void): () => void;
  cancelMp4Export(): Promise<void>;
}

declare global {
  interface Window {
    giffrey: GiffreyAPI;
  }
}
```

## Key Constraints

- **H.264 crop dimensions must be even-numbered** — main process rounds crop values before FFmpeg invocation
- **Trim uses milliseconds for FFmpeg** (not frame indices) — convert from frame-based `RenderOptions` using frame timestamps
- **Temp file cleanup** — must clean up on success, failure, AND cancel paths
- **IPC payload format** — send WebM as `ArrayBuffer` via Electron's structured clone (NOT the current number-array pattern in preload.js — that must be updated)
- **Binary packaging** — see section above; must work in packaged DMG/EXE, not just dev mode
- **Code signing** — bundled ffmpeg binary must pass macOS notarization (verified in Phase 0)

## Implementation Phases

### Phase 0: FFmpeg Packaging Proof
- Add `ffmpeg-static` dependency
- Resolve binary path in main process (dev + packaged)
- Verify `ffmpeg -version` runs in packaged macOS DMG
- Add structured error for missing/corrupted binary
- **Go/no-go:** Packaged app can execute ffmpeg; existing GIF export unaffected

### Phase 1: Mic Recording
- Add mic toggle UI to start screen
- Request `getUserMedia({audio: true})` when mic enabled
- Combine screen + mic tracks into one `MediaStream`
- Update `src/video-recorder.ts` to use `video/webm;codecs=vp9,opus`
- Store `hasAudio` flag on `Recording`
- Graceful fallback on mic denial (record screen without audio)
- **Go/no-go:** Mic denial doesn't break screen recording; WebM contains audio track when mic enabled

### Phase 2: MP4 Export IPC (includes trim/crop)
- Add IPC channels (`mp4-export:start`, `mp4-export:progress`, `mp4-export:cancel`)
- Implement main-process export pipeline (temp write → ffmpeg spawn → save → cleanup)
- Convert frame-index trim → millisecond trim using frame timestamps
- Pass crop from `RenderOptions` to FFmpeg `-vf crop=` with even-number rounding
- Parse stderr `time=` for progress reporting
- Add preload API (`exportMp4`, `onMp4ExportProgress`, `cancelMp4Export`)
- Implement cancellation (kill child process, delete temp files)
- **Go/no-go:** MP4 export succeeds with trim+crop applied; progress events fire; cancel cleans up; output plays in standard players; odd crop dimensions handled gracefully

### Phase 3: Export UI
- Add "Save MP4" button alongside "Save GIF" in play view
- Show audio indicator when mic was active
- Show MP4 export progress bar (reuse render progress pattern)
- Surface error messages with recovery actions
- Keep raw WebM export as secondary/advanced option
- **Go/no-go:** Both export options work; errors are actionable; GIF export unchanged

## Error Handling

| Error | Detection | User Message | Recovery |
|-------|-----------|--------------|----------|
| Mic denied | `getUserMedia` rejects | "Mic access denied. Recording without voice-over." | Continue with screen-only recording |
| FFmpeg missing | `spawn` ENOENT or path check | "MP4 export unavailable. Video encoder not found." | GIF export still available; suggest reinstall |
| Transcode failed | Non-zero exit code | "MP4 export failed. Original recording preserved." | Retry, save GIF, or save raw WebM |
| Disk full | ENOSPC or write error | "Not enough disk space. Free space or choose another location." | Choose new save location; retry |
| Cancel | User clicks cancel | (silent) | Return to export screen, recording preserved |

## Resolved Decisions

| Question | Answer | Rationale |
|----------|--------|-----------|
| Mic opt-in vs always-on? | Opt-in toggle | Privacy-first; permission prompt is disruptive |
| Waveform in preview? | Not in v1 | Show mic level during recording only; waveform adds complexity |
| Keep WebM export? | Yes, as secondary option | Useful for debugging and fast export without transcode |
| FFmpeg loading strategy? | N/A (native binary, resolved at startup) | Binary presence verified on app launch; error surfaced immediately if missing |
| Electron upgrade? | Not in this scope | Native FFmpeg is fast enough; upgrade is separate work |
