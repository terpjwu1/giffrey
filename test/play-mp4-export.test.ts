import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PlayView from '../src/views/play';
import { Recording, RenderOptions } from '../src/types';
import m from 'mithril';

describe('PlayView MP4 export routing', () => {
  beforeEach(() => {
    vi.spyOn(m, 'redraw').mockImplementation(() => {});
    (globalThis as any).window = {
      giffrey: {
        onMp4ExportProgress: vi.fn(() => vi.fn()),
        finalizeMp4Export: vi.fn(async () => ({ ok: true, filePath: '/tmp/out.mp4', sizeBytes: 1024 })),
        exportMp4: vi.fn(async () => ({ ok: true, filePath: '/tmp/out.mp4', sizeBytes: 1024 })),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).window;
  });

  it('uses finalized temp WebM path for a 10-minute recording instead of re-reading the Blob', async () => {
    const recording: Recording = {
      width: 1920,
      height: 1080,
      frames: [
        { imageData: {} as ImageData, timestamp: 0 },
        { imageData: {} as ImageData, timestamp: 600_000 },
      ],
      videoBlob: {
        arrayBuffer: vi.fn(async () => {
          throw new Error('Blob should not be read when tempFilePath is available');
        }),
        size: 128 * 1024 * 1024,
      } as unknown as Blob,
      tempFilePath: '/Users/test/Library/Application Support/Electron/recordings/session-test/capture.webm',
      hasAudio: true,
      durationMs: 600_000,
    };
    const renderOptions: RenderOptions = {
      trim: { start: 0, end: 1 },
      crop: { left: 0, top: 0, width: 1920, height: 1080 },
    };
    const view = new PlayView({ attrs: { app: {} as any, gif: { blob: new Blob(), url: '', duration: 0, size: 0 }, recording, renderOptions } } as any) as any;

    await view.saveMp4();

    const api = (globalThis as any).window.giffrey;
    expect(api.finalizeMp4Export).toHaveBeenCalledWith(expect.objectContaining({
      inputPath: recording.tempFilePath,
      trim: { startMs: 0, endMs: 600_000 },
      crop: renderOptions.crop,
      source: expect.objectContaining({ width: 1920, height: 1080, durationMs: 600_000, hasAudio: true }),
    }));
    expect(api.exportMp4).not.toHaveBeenCalled();
    expect((recording.videoBlob as Blob).arrayBuffer).not.toHaveBeenCalled();
  });
});
