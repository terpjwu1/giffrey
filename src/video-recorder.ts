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
  appendRecordingChunk: (tempFilePath: string, chunk: ArrayBuffer) => Promise<GiffreyRecordingTempFileResult>;
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
  let backupRecorder: MediaRecorder | null = null;
  let stopped: Promise<void> | null = null;
  let resolveStop: (() => void) | null = null;
  let backupStopped: Promise<void> = Promise.resolve();
  let resolveBackupStop: (() => void) | null = null;
  let tempFilePath: string | null = null;
  let chunkWriteChain = Promise.resolve();
  let tempFileInit: Promise<void> = Promise.resolve();
  let tempFileError: Error | null = null;
  const mimeType = selectMimeType(hasAudio);

  return {
    start() {
      chunks = [];
      blob = null;
      recorder = null;
      backupRecorder = null;
      tempFilePath = null;
      backupStopped = Promise.resolve();
      chunkWriteChain = Promise.resolve();
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
      if (giffrey?.appendRecordingChunk) {
        try {
          backupStopped = new Promise((resolve) => { resolveBackupStop = resolve; });
          backupRecorder = new MediaRecorder(stream, { mimeType });
          backupRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              const chunkBlob = e.data;
              chunkWriteChain = chunkWriteChain
                .then(() => tempFileInit)
                .then(async () => {
                  const path = tempFilePath;
                  const append = getRecordingTempFileAPI()?.appendRecordingChunk;
                  if (!path || !append) return;
                  const result = await append(path, await chunkBlob.arrayBuffer());
                  if (!result.ok) {
                    throw new Error(result.error?.message || 'Failed to append recording chunk');
                  }
                })
                .catch((err) => {
                  tempFileError = err;
                });
            }
          };
          backupRecorder.onstop = () => {
            resolveBackupStop?.();
            resolveBackupStop = null;
          };
          backupRecorder.start(1000);
        } catch (err) {
          backupRecorder = null;
          backupStopped = Promise.resolve();
          resolveBackupStop = null;
          console.error('[giffrey] recording backup failed:', err);
        }
      }
      recorder.onstop = async () => {
        blob = new Blob(chunks, { type: 'video/webm' });
        await tempFileInit;
        await backupStopped;
        await chunkWriteChain;
        if (!tempFileError && tempFilePath) {
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
        if (!tempFileError && tempFilePath) {
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
      if (backupRecorder && backupRecorder.state !== 'inactive') {
        backupRecorder.stop();
      }
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
