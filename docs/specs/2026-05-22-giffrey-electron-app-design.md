# Giffrey — Electron Desktop App PRD

## Overview

Giffrey is a macOS desktop app for screen recording that exports to GIF or MP4. It wraps the open-source gifcap project in Electron, adding MP4 export via MediaRecorder API. Distributed as a `.dmg` for colleagues.

## Goals

1. Feature parity with gifcap.dev (record screen, trim, crop, render GIF)
2. MP4 export option (instant save, no re-encoding)
3. Standalone macOS app — no dev server, no browser required
4. Shareable DMG installer

## Non-Goals

- Cross-platform (Windows/Linux) — macOS only
- System tray / global hotkeys
- Auto-updates
- Cloud sync or upload

## Architecture

### Custom Protocol Pattern

```
Main Process (electron/main.js)
├── Registers app:// protocol → serves files from app root
├── Creates BrowserWindow (1200x800)
├── session.setDisplayMediaRequestHandler → source picker
└── IPC: save-dialog, app lifecycle

Renderer Process (existing gifcap + MP4 addition)
├── mithril SPA loaded via app://./index.html
├── Recording: getDisplayMedia → canvas frames + MediaRecorder
├── GIF encoding: Web Workers (quantizer.js, writer.js, encoder.wasm)
├── MP4 export: MediaRecorder blob → save dialog
└── Preload: exposes save dialog, desktopCapturer sources
```

### File Structure

```
giffrey/
├── electron/
│   ├── main.js              # Main process entry
│   └── preload.js           # Renderer preload (IPC bridge)
├── src/                     # Copied/adapted from gifcap
│   ├── main.ts              # App initialization
│   ├── gifcap.d.ts          # Types
│   ├── components/          # UI components
│   └── views/
│       ├── record.ts        # Recording (+ MediaRecorder for MP4)
│       ├── render.ts        # GIF rendering
│       └── edit.ts          # Trim/crop + format choice (GIF vs MP4)
├── encoder/                 # WASM encoder (from gifcap)
│   ├── gifencoder.js
│   ├── quantizer.js
│   ├── writer.js
│   ├── encoder.js           # Pre-built WASM glue
│   └── encoder.wasm         # Pre-built WASM binary
├── dist/                    # esbuild output
│   ├── main.js
│   └── ticker.js
├── index.html               # Entry HTML
├── main.css                 # Styles
├── media/                   # Icons, assets
├── package.json             # Electron + electron-builder config
├── tsconfig.json
└── docs/specs/              # This file
```

## Features

### F1: Screen Recording (Parity)

- Click "Start Recording" → Electron shows native source picker (screen/window)
- Records frames to canvas at capped 1280px width (existing OOM fix)
- Ticker worker controls frame timing
- "Stop Recording" ends capture, transitions to Edit view

### F2: Edit View (Parity)

- Trim: select start/end frame
- Crop: drag to select region
- Preview playback

### F3: Render as GIF (Parity)

- Quantizer workers process frames through libimagequant WASM
- Writer worker encodes GIF via gifsicle WASM
- Progress bar during render
- On completion: preview + native save dialog (defaults to ~/Desktop)

### F4: Export as MP4 (New)

- During recording, a parallel `MediaRecorder` captures the stream as WebM
- On Edit view, user sees two buttons: "Render GIF" and "Export Video"
- MP4 path: save MediaRecorder blob directly via native save dialog
- Instant (no re-encoding), but no trim/crop applied (full recording only)
- Note: MediaRecorder outputs WebM in Chromium; file extension will be `.webm` unless we transcode

### F5: Native Save Dialog

- Replaces browser download behavior
- Default save location: `~/Desktop`
- Filename suggestion: `giffrey-{timestamp}.{gif|webm}`

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Protocol | Custom `app://` | Absolute paths work, Workers load cleanly |
| MP4 method | MediaRecorder API | Zero extra deps, instant export |
| Packaging | electron-builder | Standard, produces DMG |
| Electron version | Latest stable (v30+) | Native getDisplayMedia support |
| Screen capture | setDisplayMediaRequestHandler | Shows native picker, no desktopCapturer hacks |
| Max capture width | 1280px | Prevents OOM on Retina displays |

## Data Flow

```
User clicks Record
    → getDisplayMedia() with Electron permission handler
    → Stream splits:
        ├── Canvas path: draw frames → ImageData[] (for GIF)
        └── MediaRecorder path: record stream → Blob (for MP4/WebM)

User clicks Stop
    → Edit view with frame preview

User clicks "Render GIF"
    → GifEncoder → quantizer workers → writer worker → Blob → Save dialog

User clicks "Export MP4"
    → MediaRecorder blob → Save dialog (instant)
```

## Testing Strategy (TDD)

### Unit Tests
- Custom protocol resolves paths correctly
- MediaRecorder integration produces valid blob
- GIF encoder produces output (mock workers or integration test)
- Save dialog IPC works

### Integration Tests
- App launches without errors
- Recording starts and captures frames
- GIF render completes and produces valid file
- MP4 export saves valid file

### Manual Verification
- Launch app, record screen, render GIF, save to Desktop
- Launch app, record screen, export MP4, verify playback
- Build DMG, install on clean system, verify it works

## Packaging

- `electron-builder` config in `package.json`
- Target: `dmg` (macOS)
- App icon: adapted from gifcap's existing 512x512 icon
- Bundle ID: `com.giffrey.app`
- Extra files: `encoder/encoder.js`, `encoder/encoder.wasm`

## Open Questions (Resolved)

- **WebM vs MP4**: MediaRecorder in Chromium/Electron produces WebM, not MP4. We'll save as `.webm` which plays in all modern players. Document this for users.
- **Trim/crop for MP4**: Not supported in v1. MP4 export is full recording only. GIF path supports trim/crop.
