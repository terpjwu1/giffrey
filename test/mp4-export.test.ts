import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildFFmpegArgs } from '../electron/ffmpeg';
import { parseProgress, createExportJob } from '../electron/mp4-export';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('parseProgress', () => {
  it('parses time from ffmpeg stderr line', () => {
    const line = 'frame=   60 fps= 30 q=28.0 size=     256kB time=00:00:05.00 bitrate= 419.4kbits/s speed=2.5x';
    const result = parseProgress(line, 10000);
    expect(result).toBeCloseTo(0.5, 1); // 5s / 10s = 0.5
  });

  it('returns null for non-progress lines', () => {
    expect(parseProgress('Stream mapping:', 10000)).toBeNull();
    expect(parseProgress('  Duration: 00:00:30.00', 10000)).toBeNull();
  });

  it('returns 0 for time=00:00:00.00', () => {
    const line = 'frame=    0 fps=0.0 q=0.0 size=       0kB time=00:00:00.00 bitrate=N/A';
    expect(parseProgress(line, 10000)).toBe(0);
  });

  it('handles hours in time', () => {
    const line = 'frame=  100 fps=30 q=28.0 size=    1024kB time=01:02:03.50 bitrate= 100kbits/s';
    const durationMs = 2 * 60 * 60 * 1000; // 2 hours
    const expected = ((1 * 3600 + 2 * 60 + 3.5) * 1000) / durationMs;
    expect(parseProgress(line, durationMs)).toBeCloseTo(expected, 2);
  });
});

describe('createExportJob', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'giffrey-test-'));
  });

  afterEach(() => {
    // Clean up any files left behind
    try {
      const files = require('fs').readdirSync(tempDir);
      files.forEach((f: string) => unlinkSync(join(tempDir, f)));
      require('fs').rmdirSync(tempDir);
    } catch {}
  });

  it('creates a job with pending status', () => {
    const job = createExportJob({
      inputPath: join(tempDir, 'input.webm'),
      outputPath: join(tempDir, 'output.mp4'),
      trim: { startMs: 0, endMs: 10000 },
      crop: { left: 0, top: 0, width: 640, height: 480 },
      hasAudio: true,
      durationMs: 10000,
    });

    expect(job.status).toBe('pending');
    expect(job.cancel).toBeTypeOf('function');
  });

  it('runs ffmpeg and produces an output file', async () => {
    const ffmpegStatic = require('ffmpeg-static') as string;

    // Create a minimal test WebM input using ffmpeg
    const inputPath = join(tempDir, 'input.webm');
    const outputPath = join(tempDir, 'output.mp4');

    // Generate a 2-second test video
    const { execFileSync } = require('child_process');
    execFileSync(ffmpegStatic, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=640x480:rate=12',
      '-c:v', 'libvpx-vp9', inputPath,
    ]);

    const progressValues: number[] = [];
    const job = createExportJob({
      inputPath,
      outputPath,
      trim: { startMs: 0, endMs: 2000 },
      crop: { left: 0, top: 0, width: 640, height: 480 },
      hasAudio: false,
      durationMs: 2000,
      ffmpegPath: ffmpegStatic,
      onProgress: (ratio) => progressValues.push(ratio),
    });

    const result = await job.run();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(existsSync(result.filePath)).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
    }
    expect(progressValues.length).toBeGreaterThan(0);
  }, 15000);

  it('can be cancelled mid-export', async () => {
    const ffmpegStatic = require('ffmpeg-static') as string;
    const inputPath = join(tempDir, 'input.webm');
    const outputPath = join(tempDir, 'output.mp4');

    // Generate a longer test video so we have time to cancel
    const { execFileSync } = require('child_process');
    execFileSync(ffmpegStatic, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=1280x720:rate=30',
      '-c:v', 'libvpx-vp9', '-b:v', '2M', inputPath,
    ]);

    const job = createExportJob({
      inputPath,
      outputPath,
      trim: { startMs: 0, endMs: 10000 },
      crop: { left: 0, top: 0, width: 1280, height: 720 },
      hasAudio: false,
      durationMs: 10000,
      ffmpegPath: ffmpegStatic,
    });

    // Start the export then cancel after a short delay
    const resultPromise = job.run();
    await new Promise(resolve => setTimeout(resolve, 200));
    job.cancel();

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('cancelled');
    }
  }, 15000);
});
