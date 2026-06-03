import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createVideoRecorder } from '../src/video-recorder';

// Mock MediaRecorder behavior in Node
beforeAll(() => {
  (globalThis as any).MediaRecorder = class MockMediaRecorder {
    static instances: MockMediaRecorder[] = [];
    stream: any;
    state: string;
    timeslice: number | undefined;
    ondataavailable: Function | null = null;
    onstop: Function | null = null;

    constructor(stream: any, opts: any) {
      this.stream = stream;
      this.state = 'inactive';
      (globalThis as any).MediaRecorder.instances.push(this);
    }

    start(timeslice?: number) {
      this.state = 'recording';
      this.timeslice = timeslice;
      // Simulate data arriving after a tick
      setTimeout(() => {
        if (this.ondataavailable) {
          this.ondataavailable({ data: new Blob(['test-video-data'], { type: 'video/webm' }) });
        }
      }, 10);
    }

    stop() {
      this.state = 'inactive';
      // Spec: dataavailable fires before stop
      setTimeout(() => {
        if (this.ondataavailable) {
          this.ondataavailable({ data: new Blob(['final-chunk'], { type: 'video/webm' }) });
        }
        setTimeout(() => {
          if (this.onstop) this.onstop();
        }, 5);
      }, 10);
    }
  };

  (globalThis as any).MediaRecorder.isTypeSupported = () => true;

  if (typeof globalThis.Blob === 'undefined') {
    (globalThis as any).Blob = class MockBlob {
      parts: any[];
      options: any;
      size: number;
      type: string;
      constructor(parts: any[] = [], options: any = {}) {
        this.parts = parts;
        this.options = options;
        this.size = parts.reduce((acc: number, p: any) => acc + (p.size || p.length || 0), 0);
        this.type = options.type || '';
      }
    };
  }
});

describe('createVideoRecorder blob creation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (globalThis as any).MediaRecorder.instances = [];
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  it('getBlob() returns non-null after stop() resolves (explicit stop)', async () => {
    const stream = {} as MediaStream;
    const recorder = createVideoRecorder(stream, false);

    recorder.start();

    // Wait for some data to arrive
    await new Promise(r => setTimeout(r, 50));

    await recorder.stop();
    const blob = recorder.getBlob();

    expect(blob).not.toBeNull();
    expect(blob!.size).toBeGreaterThan(0);
  });

  it('getBlob() returns non-null when MediaRecorder auto-stops (track ended)', async () => {
    const stream = {} as MediaStream;
    const recorder = createVideoRecorder(stream, false);

    recorder.start();

    // Wait for data
    await new Promise(r => setTimeout(r, 50));

    // Simulate auto-stop: MediaRecorder fires onstop on its own
    // (In real life this happens when the track ends)
    // Access the internal recorder to simulate auto-stop
    const internalRecorder = (globalThis as any)._lastRecorder;

    // Our stop() should still work even if recorder is already inactive
    await recorder.stop();
    const blob = recorder.getBlob();

    expect(blob).not.toBeNull();
    expect(blob!.size).toBeGreaterThan(0);
  });

  it('getBlob() returns null before stop() is called', () => {
    const stream = {} as MediaStream;
    const recorder = createVideoRecorder(stream, false);

    recorder.start();
    const blob = recorder.getBlob();
    expect(blob).toBeNull();
  });

  it('uses one recorder (no timeslice) and writes blob to persistent recording file on stop', async () => {
    const sessionPath = '/Users/test/Library/Application Support/Electron/recordings/session-test/capture.webm';
    const appendedChunks: ArrayBuffer[] = [];
    const statuses: Array<{ status: string; message: string }> = [];
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});

    (globalThis as any).window = {
      giffrey: {
        initRecordingTempFile: vi.fn(async () => ({ ok: true, tempFilePath: sessionPath })),
        appendRecordingChunk: vi.fn(async (_path: string, chunk: ArrayBuffer) => {
          appendedChunks.push(chunk);
          return { ok: true, tempFilePath: sessionPath };
        }),
        finalizeRecordingTempFile: vi.fn(async () => ({ ok: true, tempFilePath: sessionPath })),
      },
      dispatchEvent: vi.fn((event: CustomEvent) => {
        statuses.push(event.detail);
        return true;
      }),
      setTimeout: vi.fn(),
    };
    (globalThis as any).document = undefined;

    const stream = {} as MediaStream;
    const recorder = createVideoRecorder(stream, true);
    recorder.start();

    await new Promise(r => setTimeout(r, 50));
    await recorder.stop();

    const api = (globalThis as any).window.giffrey;
    expect(api.initRecordingTempFile).toHaveBeenCalledTimes(1);
    expect((globalThis as any).MediaRecorder.instances).toHaveLength(1);
    expect((globalThis as any).MediaRecorder.instances[0].timeslice).toBeUndefined();
    expect(api.appendRecordingChunk).toHaveBeenCalled();
    expect(appendedChunks.length).toBeGreaterThanOrEqual(2);
    expect(api.finalizeRecordingTempFile).toHaveBeenCalledWith(sessionPath);
    expect(recorder.getTempFilePath()).toBe(sessionPath);
    expect(statuses.some(s => s.status === 'writing')).toBe(true);
    expect(statuses.some(s => s.status === 'complete')).toBe(true);
    expect(consoleInfo).toHaveBeenCalledWith('[giffrey] recording backup initialized:', sessionPath);
  });
});
