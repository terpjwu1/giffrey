# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start              # Run the app in Electron (dev mode)
npm run dist:js        # Bundle TypeScript → dist/main.js (esbuild, minified, sourcemapped)
npm run build          # dist:js + electron-builder → macOS DMG
npm test               # Run all tests (vitest, single run)
npm run test:watch     # Run tests in watch mode
```

## Architecture

Giffrey is an Electron desktop app that records screen activity and exports GIF/WebM files. Everything runs locally.

### Process Model

- **Main process** (`electron/main.js`): Window management, `app://` custom protocol, IPC handlers (save-file dialog), desktop capture source selection
- **Renderer** (`index.html` → `dist/main.js`): Mithril.js UI with a class-based state machine
- **Preload** (`electron/preload.js`): Context isolation bridge exposing `window.giffrey` API (saveGif, saveVideo, saveFile)

### State Machine (`src/main.ts`)

The app is a 5-state machine managed by the `Main` class:

```
start → recording → previewing → rendering → playing
                        ↑                        |
                        └──── discardGif ────────┘
```

Each state maps to a view in `src/views/`. State transitions trigger `m.redraw()`.

### Data Flow

1. **Capture** (`src/views/record.ts`): `getDisplayMedia()` + Web Worker ticker at 12 FPS → canvas drawImage → `ImageData` frames with timestamps. Simultaneously records WebM via `MediaRecorder`.
2. **Edit** (`src/views/preview.ts`): Interactive trim (start/end frame) and crop (drag/resize box). Produces `RenderOptions`.
3. **Encode** (`src/views/render.ts`): Iterates frames, extracts cropped region, feeds to `GifEncoder`. Uses `setTimeout(0)` per frame to avoid blocking.
4. **Save** (`src/views/play.ts`): Blob → IPC → native save dialog → `fs.writeFileSync`.

### GIF Encoder (`encoder/`)

WebAssembly-based (compiled from C via Emscripten). Key files:
- `gifencoder.js`: Orchestrator — `addFrame(imageData, delay)` → `render()` → emits `finished` event with Blob
- `quantizer.js`: Color palette reduction (libimagequant)
- `writer.js`: GIF binary format writer
- `encoder.c` / `Makefile`: C source compiled to `encoder.js` + `encoder.wasm` (downloaded from gifcap.dev during CI, not compiled locally)

### Web Worker (`workers/ticker.js`)

Single-line worker that fires `postMessage` at the configured FPS interval. Decouples frame capture timing from the UI thread.

## Key Types (`src/types.d.ts`)

- `Frame`: `{ imageData: ImageData, timestamp: number }`
- `Recording`: `{ width, height, frames: Frame[], videoBlob?: Blob }`
- `RenderOptions`: `{ trim: { start, end }, crop: { top, left, width, height } }`
- `Gif`: `{ blob: Blob, url: string, duration, size }`

## Tech Stack

- **UI**: Mithril 2.x (class components, `m.redraw()` for updates)
- **Bundler**: esbuild (target: Chrome 120)
- **Packaging**: electron-builder (macOS DMG, Windows EXE)
- **Tests**: Vitest (Node environment)
- **TypeScript**: Strict mode, ES2020

## Testing Rules

**NEVER ask the user to test something you haven't tested yourself first.** Before claiming a fix works:

1. Write an automated test that exercises the REAL scenario (realistic file sizes, realistic durations — not 3-second toy recordings)
2. Run the test and confirm it passes end-to-end
3. Send to Codex for review
4. Only THEN tell the user it's ready

If you can't test it automatically (e.g., native OS dialogs), say so explicitly rather than asking the user to be your QA.

**Test edge cases, not happy paths.** If the user will use 5-minute recordings, test with 10 minutes. If they use audio, test with audio. Never take shortcuts — a 30-second test does NOT validate a 10-minute use case. Over-achieve on test duration and complexity.

## NEVER KILL THE APP WHILE THE USER IS USING IT

**NEVER run `pkill`, `kill`, or any process-terminating command on Electron/the app without EXPLICITLY asking the user first.** The user's recordings and session state exist only in memory. Killing the app destroys their work permanently. There is no recovery.

- If you need to test, launch a SEPARATE instance or use Playwright (which launches its own process)
- If you need to rebuild, tell the user to restart manually
- NEVER assume it's safe to kill — always ask
- Violating this rule wastes the user's time and destroys their data

## CI/CD

GitHub Actions (`.github/workflows/release.yml`) triggers on `v*` tags. Builds Mac + Windows artifacts, downloads encoder WASM from gifcap.dev, creates GitHub Release.
