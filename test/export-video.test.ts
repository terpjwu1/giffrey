import { describe, it, expect } from 'vitest';
import { shouldShowExportVideo, exportVideo } from '../src/export-video';

describe('Export Video feature', () => {
  it('shouldShowExportVideo returns true when videoBlob exists', () => {
    const recording = { videoBlob: new Blob(['test'], { type: 'video/webm' }) };
    expect(shouldShowExportVideo(recording as any)).toBe(true);
  });

  it('shouldShowExportVideo returns false when videoBlob is null', () => {
    const recording = { videoBlob: null };
    expect(shouldShowExportVideo(recording as any)).toBe(false);
  });

  it('shouldShowExportVideo returns false when videoBlob is undefined', () => {
    const recording = {};
    expect(shouldShowExportVideo(recording as any)).toBe(false);
  });

  it('exportVideo calls saveVideo with the blob array buffer', async () => {
    const testBlob = new Blob(['video-data'], { type: 'video/webm' });
    let savedBlob: ArrayBuffer | null = null;

    const mockGiffrey = {
      saveVideo: async (blob: ArrayBuffer) => {
        savedBlob = blob;
        return '/path/to/file.webm';
      },
    };

    const result = await exportVideo(testBlob, mockGiffrey as any);
    expect(savedBlob).not.toBeNull();
    expect(result).toBe('/path/to/file.webm');
  });
});
