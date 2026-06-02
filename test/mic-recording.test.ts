import { describe, it, expect, vi, beforeAll } from 'vitest';
import { buildCombinedStream, selectMimeType } from '../src/mic-utils';

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
  it('returns vp9,opus when hasAudio is true', () => {
    expect(selectMimeType(true)).toBe('video/webm;codecs=vp9,opus');
  });

  it('returns vp9 when hasAudio is false', () => {
    expect(selectMimeType(false)).toBe('video/webm;codecs=vp9');
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
