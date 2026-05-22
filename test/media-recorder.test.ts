import { describe, it, expect } from 'vitest';
import { createVideoRecorder, VideoRecording } from '../src/video-recorder';

describe('video recorder', () => {
  it('exports createVideoRecorder function', () => {
    expect(typeof createVideoRecorder).toBe('function');
  });

  it('returns object with start, stop, and getBlob methods', () => {
    // Mock MediaRecorder since we're in Node
    const mockStream = {} as MediaStream;
    const recorder = createVideoRecorder(mockStream);

    expect(recorder).toHaveProperty('start');
    expect(recorder).toHaveProperty('stop');
    expect(recorder).toHaveProperty('getBlob');
    expect(typeof recorder.start).toBe('function');
    expect(typeof recorder.stop).toBe('function');
    expect(typeof recorder.getBlob).toBe('function');
  });

  it('getBlob returns null before recording stops', () => {
    const mockStream = {} as MediaStream;
    const recorder = createVideoRecorder(mockStream);
    expect(recorder.getBlob()).toBeNull();
  });
});
