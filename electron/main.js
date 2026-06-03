const { app, BrowserWindow, protocol, session, ipcMain, dialog, desktopCapturer, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { createExportJob } = require('./mp4-export');
const { resolveFFmpegPath, validateFFmpeg } = require('./ffmpeg');

const APP_ROOT = path.join(__dirname, '..');

function resolveAppProtocol(url) {
  const parsed = new URL(url);
  const relativePath = decodeURIComponent(parsed.host + parsed.pathname).replace(/^\.?\/?/, '');
  const resolved = path.resolve(APP_ROOT, relativePath);

  if (!resolved.startsWith(APP_ROOT + path.sep) && resolved !== APP_ROOT) {
    return null;
  }
  return resolved;
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}]);

let mainWindow;

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const filePath = resolveAppProtocol(request.url);
    if (filePath && fs.existsSync(filePath)) {
      return net.fetch(pathToFileURL(filePath).toString());
    }
    return new Response('Not Found', { status: 404 });
  });

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length > 0) {
        callback({ video: sources[0], audio: 'loopback' });
      } else {
        callback({});
      }
    });
  });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL('app://./index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
});

ipcMain.handle('save-file', async (event, { blob, filename, filters }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('desktop'), filename),
    filters: filters || [{ name: 'All Files', extensions: ['*'] }],
  });

  if (!result.canceled && result.filePath) {
    const buffer = Buffer.from(blob);
    fs.writeFileSync(result.filePath, buffer);
    return result.filePath;
  }
  return null;
});

let activeExportJob = null;
const activeExportSessions = new Map();
const activeRecordingTempFiles = new Map();
const MAX_MP4_EXPORT_IPC_BYTES = 1024 * 1024;

function createWriteError(err) {
  const code = err.code === 'ENOSPC' ? 'disk_full' : 'write_failed';
  return { code, message: `Failed to write temp file: ${err.message}`, recoverable: true };
}

function removeExportSession(sessionId) {
  const session = activeExportSessions.get(sessionId);
  if (!session) return;

  activeExportSessions.delete(sessionId);
  session.closed = true;
  try { session.stream.destroy(); } catch {}
  try { fs.rmSync(session.tempDir, { recursive: true, force: true }); } catch {}
}

function writeSessionChunk(session, chunk) {
  return new Promise((resolve) => {
    if (session.error) {
      resolve({ ok: false, error: createWriteError(session.error) });
      return;
    }

    const buffer = Buffer.from(chunk);
    const onError = (err) => {
      cleanup();
      resolve({ ok: false, error: createWriteError(err) });
    };
    const onDrain = () => {
      cleanup();
      resolve({ ok: true });
    };
    const cleanup = () => {
      session.stream.off('error', onError);
      session.stream.off('drain', onDrain);
    };

    session.stream.once('error', onError);
    if (session.stream.write(buffer)) {
      cleanup();
      resolve({ ok: true });
      return;
    }
    session.stream.once('drain', onDrain);
  });
}

function closeSessionStream(session) {
  return new Promise((resolve) => {
    if (session.error) {
      resolve({ ok: false, error: createWriteError(session.error) });
      return;
    }

    const onError = (err) => {
      cleanup();
      resolve({ ok: false, error: createWriteError(err) });
    };
    const onFinish = () => {
      cleanup();
      session.closed = true;
      resolve({ ok: true });
    };
    const cleanup = () => {
      session.stream.off('error', onError);
      session.stream.off('finish', onFinish);
    };

    session.stream.once('error', onError);
    session.stream.once('finish', onFinish);
    session.stream.end();
  });
}

function isActiveRecordingTempFile(tempFilePath) {
  if (!tempFilePath || !activeRecordingTempFiles.has(tempFilePath)) return false;
  const resolvedPath = path.resolve(tempFilePath);
  return resolvedPath === tempFilePath && resolvedPath.startsWith(os.tmpdir() + path.sep);
}

function isRecordingTempFilePath(tempFilePath) {
  if (!tempFilePath) return false;
  const resolvedPath = path.resolve(tempFilePath);
  return resolvedPath === tempFilePath && resolvedPath.startsWith(os.tmpdir() + path.sep) && path.basename(resolvedPath) === 'capture.webm';
}

ipcMain.handle('recording-temp:init', async () => {
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giffrey-recording-'));
  } catch (err) {
    const code = err.code === 'ENOSPC' ? 'disk_full' : 'write_failed';
    return { ok: false, error: { code, message: `Failed to create recording temp directory: ${err.message}`, recoverable: true } };
  }

  const tempFilePath = path.join(tempDir, 'capture.webm');
  try {
    fs.closeSync(fs.openSync(tempFilePath, 'wx'));
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    return { ok: false, error: createWriteError(err) };
  }

  activeRecordingTempFiles.set(tempFilePath, tempDir);
  return { ok: true, tempFilePath };
});

ipcMain.handle('recording-temp:append', async (_event, { tempFilePath, chunk }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  try {
    fs.appendFileSync(tempFilePath, Buffer.from(chunk));
    return { ok: true, tempFilePath };
  } catch (err) {
    return { ok: false, error: createWriteError(err) };
  }
});

ipcMain.handle('recording-temp:replace', async (_event, { tempFilePath, blob }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  try {
    fs.writeFileSync(tempFilePath, Buffer.from(blob));
    return { ok: true, tempFilePath };
  } catch (err) {
    return { ok: false, error: createWriteError(err) };
  }
});

ipcMain.handle('recording-temp:finalize', async (_event, { tempFilePath }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  activeRecordingTempFiles.delete(tempFilePath);
  return { ok: true, tempFilePath };
});

async function runMp4Export(event, { inputPath, tempDir, trim, crop, source, suggestedFilename }) {
  if (activeExportJob) {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    return { ok: false, error: { code: 'transcode_failed', message: 'An export is already in progress', recoverable: true } };
  }

  const saveResult = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('desktop'), suggestedFilename),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    return { ok: false, error: { code: 'cancelled', message: 'Save cancelled', recoverable: true } };
  }

  const ffmpegPath = resolveFFmpegPath(app.isPackaged, process.resourcesPath);
  const validation = await validateFFmpeg(ffmpegPath);
  if (!validation.valid) {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    return { ok: false, error: validation.error };
  }

  activeExportJob = createExportJob({
    inputPath,
    outputPath: saveResult.filePath,
    trim,
    crop,
    hasAudio: source.hasAudio,
    durationMs: source.durationMs,
    ffmpegPath,
    onProgress: (ratio) => {
      if (event.sender && !event.sender.isDestroyed()) {
        event.sender.send('mp4-export:progress', { phase: 'transcoding', ratio });
      }
    },
  });

  try {
    const result = await activeExportJob.run();
    return result;
  } catch (err) {
    return { ok: false, error: { code: 'transcode_failed', message: `Unexpected error: ${err.message}`, recoverable: true } };
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
    activeExportJob = null;
  }
}

ipcMain.handle('mp4-export:init', async () => {
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giffrey-export-'));
  } catch (err) {
    const code = err.code === 'ENOSPC' ? 'disk_full' : 'write_failed';
    return { ok: false, error: { code, message: `Failed to create temp directory: ${err.message}`, recoverable: true } };
  }

  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(tempDir, 'input.webm');
  const stream = fs.createWriteStream(inputPath);
  const session = { tempDir, inputPath, stream, closed: false, error: null };
  stream.on('error', (err) => { session.error = err; });
  activeExportSessions.set(sessionId, session);
  return { ok: true, sessionId };
});

ipcMain.handle('mp4-export:chunk', async (_event, { sessionId, chunk }) => {
  const session = activeExportSessions.get(sessionId);
  if (!session || session.closed) {
    return { ok: false, error: { code: 'write_failed', message: 'Export session is not available', recoverable: true } };
  }

  const result = await writeSessionChunk(session, chunk);
  if (!result.ok) {
    removeExportSession(sessionId);
  }
  return result;
});

ipcMain.handle('mp4-export:finalize', async (event, request) => {
  const { sessionId, inputPath, trim, crop, source, suggestedFilename } = request;
  if (inputPath) {
    if (!isRecordingTempFilePath(inputPath) || !fs.existsSync(inputPath)) {
      return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
    }
    return runMp4Export(event, { inputPath, tempDir: null, trim, crop, source, suggestedFilename });
  }

  const session = activeExportSessions.get(sessionId);
  if (!session || session.closed) {
    return { ok: false, error: { code: 'write_failed', message: 'Export session is not available', recoverable: true } };
  }

  const closeResult = await closeSessionStream(session);
  if (!closeResult.ok) {
    removeExportSession(sessionId);
    return closeResult;
  }

  activeExportSessions.delete(sessionId);
  return runMp4Export(event, { inputPath: session.inputPath, tempDir: session.tempDir, trim, crop, source, suggestedFilename });
});

ipcMain.handle('mp4-export:start', async (event, request) => {
  const { webm, trim, crop, source, suggestedFilename } = request;
  if (!webm || webm.byteLength > MAX_MP4_EXPORT_IPC_BYTES) {
    return { ok: false, error: { code: 'payload_too_large', message: 'Use streamed MP4 export for recordings larger than 1 MB', recoverable: true } };
  }

  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giffrey-export-'));
  } catch (err) {
    const code = err.code === 'ENOSPC' ? 'disk_full' : 'write_failed';
    return { ok: false, error: { code, message: `Failed to create temp directory: ${err.message}`, recoverable: true } };
  }

  const inputPath = path.join(tempDir, 'input.webm');

  try {
    fs.writeFileSync(inputPath, Buffer.from(webm));
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return { ok: false, error: createWriteError(err) };
  }

  return runMp4Export(event, { inputPath, tempDir, trim, crop, source, suggestedFilename });
});

ipcMain.handle('mp4-export:cancel', async () => {
  const hadActiveJob = !!activeExportJob;
  if (activeExportJob) {
    activeExportJob.cancel();
  }
  for (const sessionId of activeExportSessions.keys()) {
    removeExportSession(sessionId);
  }
  return { ok: true, cancelled: hadActiveJob };
});

app.on('window-all-closed', () => {
  app.quit();
});
