# Giffrey

A desktop screen recorder for macOS that captures at full Retina resolution and exports to GIF or MP4.

Built with Electron, powered by Apple's ScreenCaptureKit for native pixel-perfect capture.

![macOS](https://img.shields.io/badge/macOS-13%2B-blue) ![Electron](https://img.shields.io/badge/Electron-30-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Speaker face bubble** — circular webcam overlay (PiP), position it before recording, composited on export
- **Native Retina capture** — records at physical pixel resolution (3456x2234 on MacBook Pro) via ScreenCaptureKit
- **Hardware H.264 encoding** — VideoToolbox accelerated, minimal CPU usage during recording
- **Microphone recording** — captures voice commentary alongside screen
- **GIF export** — trim and crop, then encode via WebAssembly
- **MP4 export** — near-lossless quality (CRF 18), instant remux when no edits applied
- **Up to 15 minutes** — preview frames capped at 1 FPS/¼ res, recording writes to disk

## Quick Start

```bash
# Install dependencies
npm install

# Build the native capture helper (macOS only)
cd native && swift build -c release
codesign --force --sign - .build/release/giffrey-sck-capture
cd ..

# Build the renderer
npm run dist:js

# Launch
npm start
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│  Record                                                      │
│                                                              │
│  ScreenCaptureKit ──→ VideoToolbox H.264 ──→ MP4 file       │
│  (3456x2234 native)   (hardware encoded)    (temp)          │
│                                                              │
│  + Microphone ──→ AAC (48kHz) ──→ same MP4                   │
├─────────────────────────────────────────────────────────────┤
│  Preview & Edit                                              │
│                                                              │
│  Trim (start/end) + Crop (drag box)                         │
├─────────────────────────────────────────────────────────────┤
│  Export                                                      │
│                                                              │
│  No edits:  FFmpeg -c copy (instant, zero quality loss)     │
│  With trim:  FFmpeg CRF 18 video + AAC 128k audio           │
│  With crop:  FFmpeg CRF 18 video + audio copy               │
│  GIF: WebAssembly encoder (libimagequant)                   │
└─────────────────────────────────────────────────────────────┘
```

## Recording Quality

| Setting | Value |
|---------|-------|
| Video resolution | Physical display pixels (e.g., 3456x2234) |
| Video codec | H.264 High Profile (VideoToolbox hardware) |
| Video bitrate | ~8 Mbps (AVAssetWriter target) |
| Audio codec | AAC 48kHz mono (128 kbps) |
| Export quality | CRF 18 (near visually lossless) |
| FPS | 15 (configurable) |

## Architecture

```
native/                     Swift ScreenCaptureKit helper (146 KB binary)
electron/main.js            Electron main process, IPC handlers, FFmpeg orchestration
electron/preload.js         Context bridge (renderer ↔ main)
src/views/record.ts         Recording UI + dual capture (native + GIF frames)
src/views/preview.ts        Trim/crop editor
src/views/render.ts         GIF encoding
src/views/play.ts           Export UI (Save GIF / Save MP4)
src/capture-resolution.ts   Retina display info + dimension calculation
encoder/                    WebAssembly GIF encoder (libimagequant)
```

## Requirements

- **macOS 13+** (ScreenCaptureKit)
- **Xcode Command Line Tools** (`xcode-select --install`)
- **Node.js 18+**
- **Screen Recording permission** (prompted on first use)
- **Microphone permission** (if recording voice)

## Fallback Mode

On macOS < 13, when Screen Recording permission is denied, or on non-Mac platforms:
- Falls back to Electron's `getDisplayMedia` + canvas upscaling
- Still produces full-resolution output (upscaled from logical pixels)
- Quality is good but not pixel-perfect for text

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for planned features.

## Tech Stack

- **Runtime**: Electron 30 (Chromium 124)
- **UI**: Mithril.js 2.x
- **Native capture**: Swift + ScreenCaptureKit + VideoToolbox
- **Video processing**: FFmpeg (via ffmpeg-static)
- **GIF encoding**: WebAssembly (Emscripten, libimagequant)
- **Bundler**: esbuild
- **Tests**: Vitest

## License

MIT
