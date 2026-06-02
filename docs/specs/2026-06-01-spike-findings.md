# Technical Spike: MP4 Export + Voice-Over

## Summary of Findings

### 1. SharedArrayBuffer / Cross-Origin Isolation in Electron

**Result:** SharedArrayBuffer WORKS with the `app://` custom protocol IF headers are set in the Response object.

- `file://` + `webRequest.onHeadersReceived` headers → **DOES NOT WORK** (SAB=false)
- `app://` protocol with `Response` headers (COOP/COEP) → **WORKS** (SAB=true, crossOriginIsolated=true)  
- localhost HTTP server with headers → **WORKS** (SAB=true)

**Implication:** FFmpeg.wasm multi-threaded mode is viable. Requires modifying `electron/main.js` protocol handler to include COOP/COEP headers in every response.

### 2. MediaRecorder Codec Support (Electron 30)

| Codec | Supported |
|-------|-----------|
| video/webm;codecs=vp8 | YES |
| video/webm;codecs=vp9 | YES |
| video/webm;codecs=vp9,opus | YES |
| video/webm;codecs=vp8,opus | YES |
| video/mp4;codecs=avc1 | NO |
| video/mp4;codecs=avc1.42E01E,mp4a.40.2 | NO |
| video/mp4 | NO |

**Implication:** Cannot record directly to MP4 in Electron 30. Must record as WebM and transcode. (Electron 42+ does support MP4 MediaRecorder.)

### 3. Bundle Size Comparison

| Approach | Size (installed) | Notes |
|----------|-----------------|-------|
| @ffmpeg/core (single-thread WASM) | 31 MB | One .wasm file |
| @ffmpeg/ffmpeg + @ffmpeg/core total | 62 MB | Includes both ESM + UMD builds (can tree-shake to ~31MB) |
| @ffmpeg/core-mt (multi-thread) | Not measured (similar) | Needs SharedArrayBuffer |
| ffmpeg-static (native binary) | 43 MB | Single arm64 Mach-O binary |

**Implication:** Both approaches add ~30-45 MB. Native binary is slightly smaller and doesn't require shipping duplicate ESM/UMD builds.

### 4. Transcode Performance (Native FFmpeg on Apple Silicon)

| Test | Duration | Speed |
|------|----------|-------|
| 10s 720p VP9 → H.264 MP4 (no audio) | 0.23s | 6.3x realtime |
| 30s 720p VP9+Opus → H.264+AAC MP4 with trim+crop | 0.19s | ~7x realtime |

**Implication:** Native FFmpeg is extremely fast — a 30-second recording with trim+crop transcodes in under 200ms. Users would perceive this as instant.

### 5. FFmpeg.wasm vs Native — Decision Matrix

| Factor | FFmpeg.wasm | Native ffmpeg-static |
|--------|-------------|---------------------|
| Bundle size | ~31 MB (WASM) | ~43 MB (binary) |
| Speed | Slower (WASM overhead, ~2-3x native) | Extremely fast (0.2s for 30s video) |
| SharedArrayBuffer | Required (must modify protocol handler) | Not needed |
| Cross-platform | Single WASM works everywhere | Need per-platform binary (arm64/x86, mac/win) |
| Electron integration | Renderer process, Web Worker | Main process, child_process.spawn |
| Sandboxing | Runs in renderer sandbox | Needs main process IPC |
| Error handling | Promise-based, in-process | Parse stderr, exit codes |
| Security | Sandboxed | Binary execution (code signing matters) |

### 6. Recommendation

**Native `ffmpeg-static` is the better choice for this app because:**

1. Giffrey is already an Electron app with a main process that handles file I/O via IPC — spawning FFmpeg in a child process fits the existing architecture perfectly.
2. Performance is 2-3x better than WASM (sub-200ms for typical recordings).
3. No SharedArrayBuffer/COOP/COEP complexity — avoids modifying the protocol handler and risking breaking existing functionality.
4. The app already builds platform-specific binaries (macOS DMG + Windows EXE) via electron-builder, so bundling a per-platform ffmpeg binary is natural.
5. `ffmpeg-static` handles platform detection automatically at install time.

**Trade-off:** Cross-platform binary management adds CI complexity, but electron-builder already handles platform-specific packaging.

### 7. Proposed Architecture

```
Recording (renderer):
  getDisplayMedia() + getUserMedia({audio: true})
  → Combined MediaStream (screen video + mic audio)
  → MediaRecorder (video/webm;codecs=vp9,opus)
  → WebM Blob with audio

Export (main process via IPC):
  Renderer sends: { webmBlob, trim: {start, end}, crop: {x, y, w, h} }
  Main process:
    1. Write WebM to temp file
    2. Spawn ffmpeg: -ss start -to end -vf crop=w:h:x:y -c:v libx264 -c:a aac output.mp4
    3. Read MP4, send back to renderer (or save directly via dialog)
    4. Clean up temp files

GIF export unchanged (existing WASM encoder in renderer).
```

### 8. Open Items for Design

1. **Electron upgrade consideration:** If we upgrade to Electron 42+, we get native MP4 MediaRecorder (no transcode needed for basic use cases). Worth evaluating separately.
2. **H.264 crop dimensions must be even-numbered** — need to round crop values from preview UI.
3. **ffmpeg-static ships one arch per platform** — arm64 vs x86_64 handling on macOS.
4. **Progress reporting:** Parse ffmpeg stderr for `time=` lines to show progress bar.
5. **Max recording size:** Should we cap duration/resolution to prevent OOM?
