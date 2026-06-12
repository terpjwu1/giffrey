# Giffrey Roadmap

## Next Up

### Speaker Face Bubble (Picture-in-Picture)
Show the speaker's face in a circular overlay during recording — like Loom/Screen Studio style.

**Concept:**
```
┌────────────────────────────────────┐
│                                    │
│        Screen Recording            │
│                                    │
│                                    │
│                         ┌────┐     │
│                         │ 😊 │     │
│                         └────┘     │
└────────────────────────────────────┘
                          ↑
                    Circular webcam
                    overlay (draggable)
```

**Implementation approach:**
1. Add AVCaptureDevice video input (front camera) to Swift helper
2. Composite the camera feed as a circular overlay onto the screen capture
3. Position: bottom-right corner (user-configurable via drag)
4. Size: ~150px diameter (configurable)
5. Masking: circular clip with subtle border/shadow
6. Could be composited in Swift (via Core Image) or as a separate video track merged by FFmpeg

**Key decisions needed:**
- Composite in real-time during capture (Swift side) vs post-process (FFmpeg overlay filter)?
- Real-time is better UX (see yourself while recording) but more complex
- Post-process is simpler but user can't see/position the bubble during recording

### System Audio + Mic Mixing
Currently mic-only or system-only. Add option to capture both and mix into a single stereo track (mic left, system right, or proper mix).

### True Native Capture on Non-Retina
Currently the Swift helper always uses `backingScaleFactor` to determine physical resolution. On external non-Retina monitors, verify it captures at the correct 1:1 resolution without upscaling artifacts.

## Medium Term

### Recording Length > 10 Minutes
- Profile memory usage for 30+ minute recordings
- GIF frame buffer already bounded (600 frames max)
- MP4 recording via Swift helper should work indefinitely (writes to disk)
- Stress test: verify AVAssetWriter handles 1+ hour recordings

### Export Quality Presets
- **Quick** (CRF 28, fast preset) — small files for Slack/Discord
- **Quality** (CRF 18, medium preset) — current default
- **Archive** (CRF 0, veryslow) — lossless master copy

### Multi-Cut Editor (Remove Dead Space)
Go beyond simple start/end trimming — allow cutting out arbitrary segments from the middle of a recording.

**Use case:** You record a 5-minute demo but have 30 seconds of waiting for a page to load, 10 seconds of fumbling with a menu, etc. Cut those out and export a tight, polished clip.

**Concept:**
```
Timeline:  [████████░░░░████████████░░████████████]
                     ↑           ↑
               cut out these dead sections
               
Result:    [████████████████████████████████████]
           (seamless, shorter video)
```

**Implementation approach:**
1. Timeline UI: visual waveform/thumbnail strip with frame-level scrubbing
2. Mark IN/OUT points for segments to keep (or segments to remove)
3. Multiple cut regions stored as array: `[{start, end}, {start, end}, ...]`
4. FFmpeg concat demuxer: split into segments, then concatenate
   ```
   ffmpeg -i input.mp4 -vf "select='between(t,0,5)+between(t,8,15)+between(t,20,30)',setpts=N/FRAME_RATE/TB" -af "aselect='...', asetpts=N/SR/TB" output.mp4
   ```
5. Or use the FFmpeg concat protocol with segment files (more reliable for long recordings)

**Key decisions:**
- Frame-accurate cuts vs keyframe-aligned cuts (keyframe = instant but less precise)
- Show waveform for audio (helps identify silence/dead space)
- Auto-detect silence/stillness and suggest cuts?
- Undo/redo for cut operations

### Trim & Crop in Preview
- Preview shows GIF frames (quarter resolution) — trimming works
- Cropping on native MP4: add visual crop overlay on full-res preview
- FFmpeg handles the actual crop on export (`-vf crop=...`)

## Future

### Windows/Linux Support
- ScreenCaptureKit is macOS-only
- Windows: investigate Desktop Duplication API or OBS-style capture
- Linux: PipeWire/XDG Desktop Portal screen capture
- The Electron getDisplayMedia fallback already works on all platforms

### Annotations & Drawing
- Draw arrows, boxes, text on screen during recording
- Render as SVG overlay composited by the Swift helper or FFmpeg

### Auto-Zoom
- Detect mouse activity areas and auto-zoom/pan to follow action
- Post-processing: analyze mouse coordinates from recording, generate zoom keyframes
- Apply as FFmpeg zoompan filter during export

### Cloud Upload
- Direct upload to YouTube, Vimeo, or custom S3 bucket after export
- Generate shareable link
- Thumbnail extraction

## Technical Debt

### Sync ffmpeg.ts and ffmpeg.js
The TypeScript source and JavaScript runtime copy have diverged. Either:
- Add a build step that compiles `electron/*.ts` to `electron/*.js`
- Or convert electron/ to use esbuild like the renderer

### Crop Filter Safety
`electron/ffmpeg.ts` always applies crop; `electron/ffmpeg.js` has a broken `isFullCrop` check. Should use expression-based crop (`min(W\,iw):min(H\,ih)`) for safety — see `docs/retina-resolution-investigation.md`.

### Test Coverage for Native Path
- Add integration tests that verify Swift helper produces valid MP4
- Test SIGTERM shutdown produces non-corrupt files
- Test with different mic sample rates (24kHz AirPods, 48kHz built-in, 44.1kHz USB)
