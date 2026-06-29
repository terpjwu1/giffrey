const { contextBridge, ipcRenderer } = require('electron');

const RECORDING_TEMP_CHUNK_BYTES = 1024 * 1024;

async function writeRecordingTempFile(tempFilePath, blob) {
  const buffer = blob instanceof ArrayBuffer
    ? blob
    : blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  const init = await ipcRenderer.invoke('recording-temp:replace:init', { tempFilePath });
  if (!init.ok) return init;

  for (let offset = 0; offset < buffer.byteLength; offset += RECORDING_TEMP_CHUNK_BYTES) {
    const chunk = buffer.slice(offset, offset + RECORDING_TEMP_CHUNK_BYTES);
    const result = await ipcRenderer.invoke('recording-temp:replace:chunk', {
      tempFilePath,
      chunk,
    });
    if (!result.ok) return result;
  }

  return ipcRenderer.invoke('recording-temp:replace:complete', {
    tempFilePath,
    expectedBytes: buffer.byteLength,
  });
}

contextBridge.exposeInMainWorld('giffrey', {
  saveFile: async (blob, filename, filters) => {
    return ipcRenderer.invoke('save-file', {
      blob: Array.from(new Uint8Array(blob)),
      filename,
      filters,
    });
  },
  saveGif: async (blob) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return ipcRenderer.invoke('save-file', {
      blob: Array.from(new Uint8Array(blob)),
      filename: `giffrey-${timestamp}.gif`,
      filters: [{ name: 'GIF Image', extensions: ['gif'] }],
    });
  },
  saveVideo: async (blob) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return ipcRenderer.invoke('save-file', {
      blob: Array.from(new Uint8Array(blob)),
      filename: `giffrey-${timestamp}.webm`,
      filters: [{ name: 'WebM Video', extensions: ['webm'] }],
    });
  },
  exportMp4: async (request) => {
    return ipcRenderer.invoke('mp4-export:start', request);
  },
  initMp4Export: async () => {
    return ipcRenderer.invoke('mp4-export:init');
  },
  writeMp4ExportChunk: async (sessionId, chunk) => {
    return ipcRenderer.invoke('mp4-export:chunk', { sessionId, chunk });
  },
  finalizeMp4Export: async (request) => {
    return ipcRenderer.invoke('mp4-export:finalize', request);
  },
  initRecordingTempFile: async () => {
    return ipcRenderer.invoke('recording-temp:init');
  },
  replaceRecordingTempFile: async (tempFilePath, blob) => {
    return writeRecordingTempFile(tempFilePath, blob);
  },
  finalizeRecordingTempFile: async (tempFilePath) => {
    return ipcRenderer.invoke('recording-temp:finalize', { tempFilePath });
  },
  onMp4ExportProgress: (callback) => {
    const handler = (_event, progress) => callback(progress);
    ipcRenderer.on('mp4-export:progress', handler);
    return () => ipcRenderer.removeListener('mp4-export:progress', handler);
  },
  cancelMp4Export: async () => {
    return ipcRenderer.invoke('mp4-export:cancel');
  },
  getDisplayCaptureInfo: async () => {
    return ipcRenderer.invoke('display:get-capture-info');
  },
  isNativeCaptureAvailable: async () => {
    return ipcRenderer.invoke('sck-capture:available');
  },
  startNativeCapture: async (options) => {
    return ipcRenderer.invoke('sck-capture:start', options);
  },
  stopNativeCapture: async () => {
    return ipcRenderer.invoke('sck-capture:stop');
  },
  writeWebcamOverlay: async (buffer) => {
    return ipcRenderer.invoke('webcam-overlay:write', buffer);
  },
});
