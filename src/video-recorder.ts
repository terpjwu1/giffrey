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
type BackupStatus = 'idle' | 'initializing' | 'writing' | 'failed' | 'complete';

function setRecordingBackupStatus(status: BackupStatus, message: string): void {
  if (typeof window === 'undefined') return;

  window.dispatchEvent(new CustomEvent('giffrey-recording-backup-status', { detail: { status, message } }));

  if (typeof document === 'undefined') return;

  let indicator = document.getElementById('giffrey-recording-backup-status');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'giffrey-recording-backup-status';
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.style.position = 'fixed';
    indicator.style.right = '12px';
    indicator.style.bottom = '12px';
    indicator.style.zIndex = '9999';
    indicator.style.padding = '4px 8px';
    indicator.style.borderRadius = '999px';
    indicator.style.background = 'rgba(0, 0, 0, 0.65)';
    indicator.style.color = 'white';
    indicator.style.font = '12px system-ui, sans-serif';
    indicator.style.pointerEvents = 'none';
    document.body.appendChild(indicator);
  }

  indicator.textContent = message;
  indicator.style.display = status === 'idle' ? 'none' : 'block';
  indicator.style.background = status === 'failed' ? 'rgba(180, 35, 24, 0.9)' : 'rgba(0, 0, 0, 0.65)';
}

function reportTempFileError(err: unknown, context: string): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  console.error(`[giffrey] recording temp file ${context}:`, error);
  setRecordingBackupStatus('failed', `Recording backup failed: ${error.message}`);
  return error;
}

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
      if (!giffrey?.initRecordingTempFile || !giffrey?.appendRecordingChunk) {
        console.warn('[giffrey] recording backup unavailable: recording temp IPC API is missing');
        setRecordingBackupStatus('failed', 'Recording backup unavailable');
      } else {
        setRecordingBackupStatus('initializing', 'Recording backup starting...');
      }
      tempFileInit = giffrey?.initRecordingTempFile
        ? giffrey.initRecordingTempFile().then((result) => {
            if (!result.ok || !result.tempFilePath) {
              throw new Error(result.error?.message || 'Failed to create recording temp file');
            }
            tempFilePath = result.tempFilePath;
            console.info('[giffrey] recording backup initialized:', tempFilePath);
            setRecordingBackupStatus('writing', 'Recording backup writing...');
          }).catch((err) => {
            tempFileError = reportTempFileError(err, 'init failed');
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
                  tempFileError = reportTempFileError(err, 'append failed');
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
              tempFileError = reportTempFileError(new Error(result.error?.message || 'Failed to write final recording file'), 'replace failed');
            } else if (result.tempFilePath) {
              tempFilePath = result.tempFilePath;
            }
          }
        }
        if (!tempFileError && tempFilePath) {
          const result = await getRecordingTempFileAPI()?.finalizeRecordingTempFile?.(tempFilePath);
          if (result && (!result.ok || !result.tempFilePath)) {
            tempFileError = reportTempFileError(new Error(result.error?.message || 'Failed to finalize recording temp file'), 'finalize failed');
          } else if (result?.tempFilePath) {
            tempFilePath = result.tempFilePath;
          }
        }
        if (tempFileError) {
          console.error('[giffrey] recording temp file failed:', tempFileError);
        } else if (tempFilePath) {
          setRecordingBackupStatus('complete', 'Recording backup saved');
          window.setTimeout(() => setRecordingBackupStatus('idle', ''), 3000);
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
