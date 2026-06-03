export interface VideoRecording {
  start(): void;
  stop(): Promise<void>;
  getBlob(): Blob | null;
}

import { selectMimeType } from './mic-utils';

export function createVideoRecorder(stream: MediaStream, hasAudio: boolean = false): VideoRecording {
  let chunks: Blob[] = [];
  let blob: Blob | null = null;
  let recorder: MediaRecorder | null = null;
  let stopped: Promise<void> | null = null;
  let resolveStop: (() => void) | null = null;
  const mimeType = selectMimeType(hasAudio);

  return {
    start() {
      chunks = [];
      blob = null;
      stopped = new Promise((resolve) => { resolveStop = resolve; });
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.onstop = () => {
        blob = new Blob(chunks, { type: 'video/webm' });
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
  };
}
