const { contextBridge, ipcRenderer } = require('electron');

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
  appendRecordingChunk: async (tempFilePath, chunk) => {
    return ipcRenderer.invoke('recording-temp:append', { tempFilePath, chunk });
  },
  replaceRecordingTempFile: async (tempFilePath, blob) => {
    return ipcRenderer.invoke('recording-temp:replace', { tempFilePath, blob });
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
});
