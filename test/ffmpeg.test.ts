import { describe, it, expect } from 'vitest';
import { resolveFFmpegPath, validateFFmpeg, buildFFmpegArgs } from '../electron/ffmpeg';
import { writeFileSync, unlinkSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('resolveFFmpegPath', () => {
  it('returns a string path in dev mode', () => {
    const result = resolveFFmpegPath(false);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns ffmpeg.exe for win32 in packaged mode', () => {
    const result = resolveFFmpegPath(true, '/fake/resources', 'win32');
    expect(result).toBe('/fake/resources/ffmpeg.exe');
  });

  it('returns ffmpeg for darwin in packaged mode', () => {
    const result = resolveFFmpegPath(true, '/fake/resources', 'darwin');
    expect(result).toBe('/fake/resources/ffmpeg');
  });

  it('returns ffmpeg for linux in packaged mode', () => {
    const result = resolveFFmpegPath(true, '/fake/resources', 'linux');
    expect(result).toBe('/fake/resources/ffmpeg');
  });
});

describe('validateFFmpeg', () => {
  it('resolves true for a valid ffmpeg binary', async () => {
    const ffmpegPath = resolveFFmpegPath(false);
    const result = await validateFFmpeg(ffmpegPath);
    expect(result).toEqual({ valid: true });
  });

  it('returns structured error for missing binary', async () => {
    const result = await validateFFmpeg('/nonexistent/ffmpeg');
    expect(result).toEqual({
      valid: false,
      error: {
        code: 'ffmpeg_missing',
        message: expect.any(String),
        recoverable: false,
      },
    });
  });

  it('returns ffmpeg_invalid for existing but non-executable file', async () => {
    const fakePath = join(tmpdir(), 'fake-ffmpeg-test');
    writeFileSync(fakePath, '#!/bin/sh\nexit 1\n');
    chmodSync(fakePath, 0o755);
    try {
      const result = await validateFFmpeg(fakePath);
      expect(result.valid).toBe(false);
      expect(result.error!.code).toBe('ffmpeg_invalid');
    } finally {
      unlinkSync(fakePath);
    }
  });
});

describe('buildFFmpegArgs', () => {
  it('builds correct args with trim and crop (flags after -i for seekable output)', () => {
    const args = buildFFmpegArgs({
      inputPath: '/tmp/input.webm',
      outputPath: '/tmp/output.mp4',
      trim: { startMs: 5000, endMs: 20000 },
      crop: { left: 100, top: 50, width: 640, height: 480 },
      hasAudio: true,
    });

    // -i must come before -ss/-to for reliable trimming of MediaRecorder WebM
    const iIdx = args.indexOf('-i');
    const ssIdx = args.indexOf('-ss');
    const toIdx = args.indexOf('-to');
    expect(iIdx).toBeLessThan(ssIdx);
    expect(iIdx).toBeLessThan(toIdx);

    expect(args).toContain('5');
    expect(args).toContain('20');
    expect(args).toContain('crop=640:480:100:50');
    expect(args).toContain('-c:v');
    expect(args).toContain('libx264');
    expect(args).toContain('-c:a');
    expect(args).toContain('aac');
  });

  it('omits trim flags for full-range export sentinel while still applying crop', () => {
    const args = buildFFmpegArgs({
      inputPath: '/tmp/input.webm',
      outputPath: '/tmp/output.mp4',
      trim: { startMs: 0, endMs: -1 },
      crop: { left: 10, top: 20, width: 640, height: 480 },
      hasAudio: true,
    });

    expect(args).not.toContain('-ss');
    expect(args).not.toContain('-to');
    expect(args).toContain('-vf');
    expect(args).toContain('crop=640:480:10:20');
  });

  it('rounds crop dimensions to even numbers (floors to nearest even)', () => {
    const args = buildFFmpegArgs({
      inputPath: '/tmp/input.webm',
      outputPath: '/tmp/output.mp4',
      trim: { startMs: 0, endMs: 10000 },
      crop: { left: 101, top: 51, width: 641, height: 479 },
      hasAudio: false,
    });

    const vfIndex = args.indexOf('-vf');
    const cropArg = args[vfIndex + 1];
    // roundEven floors: 641→640, 479→478, 101→100, 51→50
    expect(cropArg).toBe('crop=640:478:100:50');
  });

  it('omits audio codec flags when hasAudio is false', () => {
    const args = buildFFmpegArgs({
      inputPath: '/tmp/input.webm',
      outputPath: '/tmp/output.mp4',
      trim: { startMs: 0, endMs: 10000 },
      crop: { left: 0, top: 0, width: 640, height: 480 },
      hasAudio: false,
    });

    expect(args).toContain('-an');
    expect(args).not.toContain('-c:a');
  });

  it('includes pix_fmt yuv420p for compatibility', () => {
    const args = buildFFmpegArgs({
      inputPath: '/tmp/input.webm',
      outputPath: '/tmp/output.mp4',
      trim: { startMs: 0, endMs: 10000 },
      crop: { left: 0, top: 0, width: 640, height: 480 },
      hasAudio: true,
    });

    expect(args).toContain('-pix_fmt');
    expect(args).toContain('yuv420p');
  });
});
