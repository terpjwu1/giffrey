# Giffrey: Blurry MP4 Export on Retina Mac — Investigation Document

## Problem Statement

Exported MP4 files from Giffrey look **visibly blurry** on a Retina MacBook Pro, despite being at the correct logical resolution (1728x1116). Text is not crisp and the overall quality appears low.

## Environment

- **Machine**: MacBook Pro with Liquid Retina XDR Display
- **Physical resolution**: 3456 x 2234 pixels
- **Logical resolution**: 1728 x 1116 (2x device pixel ratio)
- **Electron version**: 30.5.1 (Chromium 124)
- **Platform**: macOS Darwin 25.4.0

## Root Cause (confirmed)

The recording captures at **logical pixel resolution** (1728x1116) instead of the **physical pixel resolution** (3456x2234). When the exported MP4 (1728x1116) is played back on the 2x Retina display, each video pixel occupies 4 physical pixels (2x2), making text and UI appear blurry.

## Evidence

- `system_profiler SPDisplaysDataType` confirms: **3456 x 2234 Retina**
- All exported MP4s are 1728x1116 — exactly half the physical resolution
- Source WebM files from MediaRecorder are also 1728x1116
- `video.videoWidth` in the renderer reports 1728 (logical)
- `track.getSettings()` also returns 1728x1116 (did not return physical)

## Architecture of Recording Pipeline

```
getDisplayMedia({ video: { width: 9999, height: 9999 } })
    ↓ (returns MediaStream at 1728x1116 logical)
video.srcObject = stream
    ↓ (video.videoWidth = 1728)
canvas.drawImage(video, 0, 0, width, height)
    ↓ (canvas is 1728x1116)
canvas.captureStream(fps)
    ↓ (canvas stream at 1728x1116)
MediaRecorder(canvasStream, { videoBitsPerSecond: 8_000_000 })
    ↓ (records at 1728x1116)
FFmpeg transcode → MP4 at 1728x1116
```

Key file: `src/views/record.ts` (lines 55-76)
Key file: `src/main.ts` (line 123-125)
Key file: `electron/main.js` (lines 43-51 — setDisplayMediaRequestHandler)

## Electron's setDisplayMediaRequestHandler

```javascript
// electron/main.js lines 43-51
session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
  desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
    if (sources.length > 0) {
      callback({ video: sources[0], audio: 'loopback' });
    } else {
      callback({});
    }
  });
});
```

## What We've Attempted (all failed to increase resolution)

### Attempt 1: Set videoBitsPerSecond on MediaRecorder
```javascript
new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 })
```
**Result**: Chrome/Electron ignores this for screen capture streams. Source WebM was still ~400-1300 kbps regardless of the hint.

### Attempt 2: Switch from VP9 to VP8 codec
```javascript
// mic-utils.ts
return hasAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8';
```
**Result**: VP8 also ignores videoBitsPerSecond for screen content.

### Attempt 3: Lower FFmpeg CRF and change preset
```
-crf 18 -preset medium (was: -crf 23 -preset fast)
```
**Result**: Doesn't help because the SOURCE is already low quality (1728x1116). CRF 18 faithfully preserves the low-res source.

### Attempt 4: Canvas captureStream() to bypass screen-content mode
```javascript
const canvasStream = canvas.captureStream(fps);
// Record canvasStream instead of raw display stream
```
**Result**: Canvas stream respects bitrate slightly better, but the canvas is still only 1728x1116. The fundamental resolution issue remains.

### Attempt 5: Use track.getSettings() for actual device-pixel resolution
```javascript
const track = this.captureStream.getVideoTracks()[0];
const settings = track?.getSettings();
const width = settings?.width || video.videoWidth; // Still returns 1728
```
**Result**: `track.getSettings()` returns logical pixels (1728x1116), NOT physical pixels. No improvement.

### Attempt 6: Use constraint `{ width: { ideal: 9999 }, height: { ideal: 9999 } }`
**Result**: Already tried from the beginning. Chromium caps at logical resolution for getDisplayMedia.

## What We Know

1. `desktopCapturer.getSources()` in Electron's main process CAN access physical pixels
2. But by the time the stream reaches the renderer via `setDisplayMediaRequestHandler`, it's at logical pixels
3. `video.videoWidth` and `track.getSettings().width` both report 1728 (logical)
4. The `width: 9999` constraint in getDisplayMedia does NOT override this
5. The canvas draws at whatever resolution it receives (1728x1116)
6. All downstream processing (MediaRecorder, FFmpeg) faithfully preserves this resolution

## Questions for Codex

1. **How do we get `desktopCapturer` to provide physical pixels to the renderer?**
   - Is there a `thumbnailSize` or equivalent option for the video stream?
   - Does `setDisplayMediaRequestHandler` have options to request device pixels?
   - Can we pass constraints in the callback?

2. **Alternative approaches:**
   - Should we use `desktopCapturer.getSources()` with `navigator.mediaDevices.getUserMedia()` instead of `getDisplayMedia`? (The old Electron approach)
   - Can we set `webPreferences.zoomFactor = 0.5` to trick the system?
   - Should we use a hidden BrowserWindow at 2x zoom to capture?
   - Can Electron's `webContents.capturePage()` or `nativeImage` help?

3. **Is this a known Chromium/Electron limitation?**
   - Does Electron 30+ have any API for requesting device-pixel capture?
   - Is there a flag like `--force-device-scale-factor=1` that would help?

## Current Branch State

Branch: `feat/high-quality-recording` (off `main`)
All tests pass (52/52).
The VP8 codec, CRF 18, and canvas captureStream changes are in place but don't solve the resolution issue.
