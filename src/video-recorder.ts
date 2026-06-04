export interface VideoRecording {
  start(): void;
  stop(): Promise<void>;
  getBlob(): Blob | null;
  getTempFilePath(): string | null;
}

import { selectMimeType } from './mic-utils';

interface GiffreyRecordingTempFileResult {
  ok: boolean;
  tempFilePath?: string;
  error?: { message: string };
}

interface GiffreyRecordingTempFileAPI {
  initRecordingTempFile: () => Promise<GiffreyRecordingTempFileResult>;
  replaceRecordingTempFile: (tempFilePath: string, blob: ArrayBuffer) => Promise<GiffreyRecordingTempFileResult>;
  finalizeRecordingTempFile: (tempFilePath: string) => Promise<GiffreyRecordingTempFileResult>;
}

type RecordingBlob = Blob & { tempFilePath?: string };

function getRecordingTempFileAPI(): GiffreyRecordingTempFileAPI | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { giffrey?: Partial<GiffreyRecordingTempFileAPI> }).giffrey as GiffreyRecordingTempFileAPI | undefined;
}

export function createVideoRecorder(stream: MediaStream, hasAudio: boolean = false): VideoRecording {
  let chunks: Blob[] = [];
  let blob: Blob | null = null;
  let recorder: MediaRecorder | null = null;
  let stopped: Promise<void> | null = null;
  let resolveStop: (() => void) | null = null;
  let tempFilePath: string | null = null;
  let tempFileInit: Promise<void> = Promise.resolve();
  let tempFileError: Error | null = null;
  const mimeType = selectMimeType(hasAudio);

  return {
    start() {
      chunks = [];
      blob = null;
      recorder = null;
      tempFilePath = null;
      tempFileError = null;
      const giffrey = getRecordingTempFileAPI();
      tempFileInit = giffrey?.initRecordingTempFile
        ? giffrey.initRecordingTempFile().then((result) => {
            if (!result.ok || !result.tempFilePath) {
              throw new Error(result.error?.message || 'Failed to create recording temp file');
            }
            tempFilePath = result.tempFilePath;
          }).catch((err) => {
            tempFileError = err;
          })
        : Promise.resolve();
      stopped = new Promise((resolve) => { resolveStop = resolve; });
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.onstop = async () => {
        blob = new Blob(chunks, { type: 'video/webm' });
        await tempFileInit;
        // Electron 30/Chromium corrupts MediaRecorder timestamps when a second
        // recorder writes backup chunks from the same screen+mic stream. Keep a
        // single no-timeslice recorder for clean DTS; this intentionally gives
        // up crash recovery until a backup path that does not record the stream
        // concurrently is available.
        // Backup chunk errors do not affect the main recorder blob, so always write the final blob.
        if (tempFilePath) {
          const replace = getRecordingTempFileAPI()?.replaceRecordingTempFile;
          if (replace) {
            const result = await replace(tempFilePath, await blob.arrayBuffer());
            if (!result.ok) {
              tempFileError = new Error(result.error?.message || 'Failed to write final recording file');
            } else if (result.tempFilePath) {
              tempFilePath = result.tempFilePath;
            }
          }
        }
        if (tempFilePath) {
          const result = await getRecordingTempFileAPI()?.finalizeRecordingTempFile?.(tempFilePath);
          if (result && (!result.ok || !result.tempFilePath)) {
            tempFileError = new Error(result.error?.message || 'Failed to finalize recording temp file');
          } else if (result?.tempFilePath) {
            tempFilePath = result.tempFilePath;
          }
        }
        if (tempFileError) {
          console.error('[giffrey] recording temp file failed:', tempFileError);
        }
        if (tempFilePath) {
          (blob as RecordingBlob).tempFilePath = tempFilePath;
        }
        resolveStop?.();
        resolveStop = null;
      };
      recorder.start();
    },
    async stop() {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      if (stopped) await stopped;
    },
    getBlob() {
      return blob;
    },
    getTempFilePath() {
      return tempFilePath;
    },
  };
}
