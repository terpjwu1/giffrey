type InvokeFunction = (channel: string, ...args: any[]) => Promise<any>;

export function getExposedAPI(invoke?: InvokeFunction) {
  const ipcInvoke = invoke || (async () => null);

  return {
    saveFile: async (blob: ArrayBuffer, filename: string, filters?: any[]) => {
      return ipcInvoke('save-file', { blob: Array.from(new Uint8Array(blob)), filename, filters });
    },
    saveGif: async (blob: ArrayBuffer) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return ipcInvoke('save-file', {
        blob: Array.from(new Uint8Array(blob)),
        filename: `giffrey-${timestamp}.gif`,
        filters: [{ name: 'GIF Image', extensions: ['gif'] }],
      });
    },
    saveVideo: async (blob: ArrayBuffer) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return ipcInvoke('save-file', {
        blob: Array.from(new Uint8Array(blob)),
        filename: `giffrey-${timestamp}.webm`,
        filters: [{ name: 'WebM Video', extensions: ['webm'] }],
      });
    },
  };
}
