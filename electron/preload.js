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
});
