import { describe, it, expect, vi, beforeAll } from 'vitest';
import { calculateCaptureDimensions, normalizeScaleFactor } from '../src/capture-resolution';
import { buildCanvasRecordingStream, buildCombinedStream, selectMimeType } from '../src/mic-utils';

beforeAll(() => {
  // Mock MediaStream for Node environment
  if (typeof globalThis.MediaStream === 'undefined') {
    (globalThis as any).MediaStream = class MockMediaStream {
      private tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[] = []) {
        this.tracks = tracks;
      }
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
      getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    };
  }
});

describe('selectMimeType', () => {
  it('returns vp8,opus when hasAudio is true', () => {
    expect(selectMimeType(true)).toBe('video/webm;codecs=vp8,opus');
  });

  it('returns vp8 when hasAudio is false', () => {
    expect(selectMimeType(false)).toBe('video/webm;codecs=vp8');
  });
});

describe('buildCombinedStream', () => {
  it('combines video and audio tracks into one stream', () => {
    const videoTrack = { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
    const audioTrack = { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack;
    const displayStream = { getVideoTracks: () => [videoTrack] } as unknown as MediaStream;
    const micStream = { getAudioTracks: () => [audioTrack] } as unknown as MediaStream;

    const result = buildCombinedStream(displayStream, micStream);

    expect(result.stream).toBeInstanceOf(MediaStream);
    expect(result.hasAudio).toBe(true);
    expect(result.stream.getVideoTracks()).toHaveLength(1);
    expect(result.stream.getAudioTracks()).toHaveLength(1);
  });

  it('returns video-only stream when micStream is null', () => {
    const videoTrack = { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
    const displayStream = { getVideoTracks: () => [videoTrack] } as unknown as MediaStream;

    const result = buildCombinedStream(displayStream, null);

    expect(result.stream).toBeInstanceOf(MediaStream);
    expect(result.hasAudio).toBe(false);
  });
});

describe('buildCanvasRecordingStream', () => {
  it('uses canvas video tracks and mic audio tracks', () => {
    const displayVideoTrack = { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
    const canvasVideoTrack = { kind: 'video', stop: vi.fn() } as unknown as MediaStreamTrack;
    const audioTrack = { kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack;
    const canvasStream = { getVideoTracks: () => [canvasVideoTrack] } as unknown as MediaStream;
    const micStream = { getAudioTracks: () => [audioTrack] } as unknown as MediaStream;

    const result = buildCanvasRecordingStream(canvasStream, micStream);

    expect(result.stream).toBeInstanceOf(MediaStream);
    expect(result.hasAudio).toBe(true);
    expect(result.stream.getVideoTracks()).toEqual([canvasVideoTrack]);
    expect(result.stream.getVideoTracks()).not.toContain(displayVideoTrack);
    expect(result.stream.getAudioTracks()).toEqual([audioTrack]);
  });
});

describe('Retina capture dimensions', () => {
  it('upscales logical Retina capture dimensions to physical pixels', () => {
    expect(calculateCaptureDimensions(1728, 1116, { scaleFactor: 2, size: { width: 3456, height: 2234 } })).toEqual({
      sourceWidth: 1728,
      sourceHeight: 1116,
      outputWidth: 3456,
      outputHeight: 2234,
      scaleFactor: 2,
      upscaled: true,
    });
  });

  it('falls back to scale-factor math when native display size is unavailable', () => {
    expect(calculateCaptureDimensions(1728, 1116, 2)).toMatchObject({
      outputWidth: 3456,
      outputHeight: 2232,
      scaleFactor: 2,
      upscaled: true,
    });
  });

  it('keeps non-Retina capture dimensions unchanged', () => {
    expect(calculateCaptureDimensions(1920, 1080, { scaleFactor: 1, size: { width: 1920, height: 1080 } })).toMatchObject({
      outputWidth: 1920,
      outputHeight: 1080,
      scaleFactor: 1,
      upscaled: false,
    });
  });

  it('normalizes invalid display scale factors to 1', () => {
    expect(normalizeScaleFactor(undefined)).toBe(1);
    expect(normalizeScaleFactor(0)).toBe(1);
  });
});

describe('Recording type extensions', () => {
  it('Recording interface supports hasAudio and durationMs fields', () => {
    // Type-level test: verify the extended Recording interface compiles
    const recording: import('../src/types').Recording = {
      width: 1280,
      height: 720,
      frames: [],
      videoBlob: null,
      hasAudio: true,
      durationMs: 5000,
    };
    expect(recording.hasAudio).toBe(true);
    expect(recording.durationMs).toBe(5000);
  });
});
