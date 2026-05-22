export interface VideoRecording {
  start(): void;
  stop(): void;
  getBlob(): Blob | null;
}

export function createVideoRecorder(stream: MediaStream): VideoRecording {
  let chunks: Blob[] = [];
  let blob: Blob | null = null;
  let recorder: MediaRecorder | null = null;

  return {
    start() {
      chunks = [];
      blob = null;
      recorder = new MediaRecorder(stream, {
        mimeType: 'video/webm;codecs=vp9',
      });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.onstop = () => {
        blob = new Blob(chunks, { type: 'video/webm' });
      };
      recorder.start();
    },
    stop() {
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
    },
    getBlob() {
      return blob;
    },
  };
}
