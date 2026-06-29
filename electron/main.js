const { app, BrowserWindow, protocol, session, ipcMain, dialog, desktopCapturer, net, screen } = require('electron');
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
    console.log('[giffrey] display media request:', {
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
      userGesture: request.userGesture,
      securityOrigin: request.securityOrigin,
    });

    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (sources.length === 0) {
        // After `tccutil reset ScreenCapture`, macOS may require a full app relaunch after granting Screen Recording again.
        console.error('[giffrey] desktopCapturer.getSources returned no screens. Screen Recording permission may be missing; grant it in System Settings and restart Giffrey.');
        callback({});
        return;
      }

      const source = sources[0];
      if (!source) {
        console.error('[giffrey] failed to select a desktop capture source:', sources);
        callback({});
        return;
      }

      callback({ video: source, audio: 'loopback' });
    }).catch((err) => {
      console.error('[giffrey] desktopCapturer.getSources failed:', err);
      callback({});
    });
  });

  ipcMain.handle('display:get-capture-info', () => {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
    return {
      scaleFactor: display?.scaleFactor || 1,
      size: display?.size || null,
    };
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
  mainWindow.webContents.openDevTools({ mode: 'detach' });

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
const activeRecordingReplaceSessions = new Map();
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

function getRecordingsDir() {
  const dir = path.join(app.getPath('userData'), 'recordings');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function isActiveRecordingTempFile(tempFilePath) {
  if (!tempFilePath || !activeRecordingTempFiles.has(tempFilePath)) return false;
  const resolvedPath = path.resolve(tempFilePath);
  const recordingsDir = getRecordingsDir();
  return resolvedPath === tempFilePath && resolvedPath.startsWith(recordingsDir + path.sep);
}

function isRecordingTempFilePath(tempFilePath) {
  if (!tempFilePath) return false;
  const resolvedPath = path.resolve(tempFilePath);
  const recordingsDir = getRecordingsDir();
  const isWebmPath = resolvedPath === tempFilePath && resolvedPath.startsWith(recordingsDir + path.sep) && path.basename(resolvedPath) === 'capture.webm';
  const tmpDir = path.resolve(os.tmpdir());
  const sckParentDir = path.dirname(resolvedPath);
  const sckParentName = path.basename(sckParentDir);
  const isSckPath = resolvedPath === tempFilePath
    && path.dirname(sckParentDir) === tmpDir
    && sckParentName.startsWith('giffrey-sck-')
    && sckParentName.length > 'giffrey-sck-'.length
    && path.basename(resolvedPath) === 'capture.mp4';
  return isWebmPath || isSckPath;
}

function abortRecordingReplace(tempFilePath) {
  const session = activeRecordingReplaceSessions.get(tempFilePath);
  if (!session) return;

  activeRecordingReplaceSessions.delete(tempFilePath);
  try { session.stream.destroy(); } catch {}
  try { fs.rmSync(session.stagingPath, { force: true }); } catch {}
}

ipcMain.handle('recording-temp:init', async () => {
  let tempDir;
  try {
    tempDir = fs.mkdtempSync(path.join(getRecordingsDir(), 'session-'));
  } catch (err) {
    const code = err.code === 'ENOSPC' ? 'disk_full' : 'write_failed';
    return { ok: false, error: { code, message: `Failed to create recording directory: ${err.message}`, recoverable: true } };
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

ipcMain.handle('recording-temp:replace', async (_event, { tempFilePath, blob }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  try {
    const buffer = Buffer.from(blob);
    fs.writeFileSync(tempFilePath, buffer);
    return { ok: true, tempFilePath };
  } catch (err) {
    return { ok: false, error: createWriteError(err) };
  }
});

ipcMain.handle('recording-temp:replace:init', async (_event, { tempFilePath }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  abortRecordingReplace(tempFilePath);
  const stagingPath = `${tempFilePath}.part`;
  try {
    const stream = fs.createWriteStream(stagingPath, { flags: 'w' });
    activeRecordingReplaceSessions.set(tempFilePath, { stagingPath, stream, bytesWritten: 0, error: null });
    stream.on('error', (err) => {
      const session = activeRecordingReplaceSessions.get(tempFilePath);
      if (session) session.error = err;
    });
    return { ok: true, tempFilePath };
  } catch (err) {
    return { ok: false, error: createWriteError(err) };
  }
});

ipcMain.handle('recording-temp:replace:chunk', async (_event, { tempFilePath, chunk }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    abortRecordingReplace(tempFilePath);
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  const session = activeRecordingReplaceSessions.get(tempFilePath);
  if (!session) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file write is not initialized', recoverable: true } };
  }

  const result = await writeSessionChunk(session, chunk);
  if (!result.ok) {
    abortRecordingReplace(tempFilePath);
    return result;
  }

  session.bytesWritten += Buffer.byteLength(Buffer.from(chunk));
  return { ok: true, tempFilePath };
});

ipcMain.handle('recording-temp:replace:complete', async (_event, { tempFilePath, expectedBytes }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    abortRecordingReplace(tempFilePath);
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  const session = activeRecordingReplaceSessions.get(tempFilePath);
  if (!session) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file write is not initialized', recoverable: true } };
  }

  const closeResult = await closeSessionStream(session);
  if (!closeResult.ok) {
    abortRecordingReplace(tempFilePath);
    return closeResult;
  }

  if (session.bytesWritten !== expectedBytes) {
    abortRecordingReplace(tempFilePath);
    return { ok: false, error: { code: 'write_failed', message: `Recording temp file write was incomplete: expected ${expectedBytes} bytes, wrote ${session.bytesWritten}`, recoverable: true } };
  }

  try {
    fs.renameSync(session.stagingPath, tempFilePath);
  } catch (err) {
    abortRecordingReplace(tempFilePath);
    return { ok: false, error: createWriteError(err) };
  }

  activeRecordingReplaceSessions.delete(tempFilePath);
  return { ok: true, tempFilePath };
});

ipcMain.handle('recording-temp:finalize', async (_event, { tempFilePath }) => {
  if (!isActiveRecordingTempFile(tempFilePath)) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file is not available', recoverable: true } };
  }

  if (activeRecordingReplaceSessions.has(tempFilePath)) {
    return { ok: false, error: { code: 'write_failed', message: 'Recording temp file write is still in progress', recoverable: true } };
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

// --- ScreenCaptureKit native capture ---

const { spawn } = require('child_process');
let sckProcess = null;

function resolveSckHelperPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'native', 'giffrey-sck-capture');
  }
  return path.join(__dirname, '..', 'native', '.build', 'release', 'giffrey-sck-capture');
}

ipcMain.handle('sck-capture:available', async () => {
  const helperPath = resolveSckHelperPath();
  return { available: process.platform === 'darwin' && fs.existsSync(helperPath) };
});

ipcMain.handle('sck-capture:start', async (_event, { fps, includeAudio, includeMic, enableCamera, cameraX, cameraY, cameraSize }) => {
  if (sckProcess) {
    return { ok: false, error: 'Capture already in progress' };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'giffrey-sck-'));
  const outputPath = path.join(tempDir, 'capture.mp4');
  const helperPath = resolveSckHelperPath();

  if (!fs.existsSync(helperPath)) {
    return { ok: false, error: 'Native capture helper not found' };
  }

  const args = ['--output', outputPath, '--fps', String(fps || 15), '--display', '0'];
  if (includeAudio) args.push('--audio');
  if (includeMic) args.push('--mic');
  if (enableCamera) {
    args.push('--camera');
    if (cameraX != null) args.push('--camera-x', String(cameraX));
    if (cameraY != null) args.push('--camera-y', String(cameraY));
    if (cameraSize != null) args.push('--camera-size', String(cameraSize));
  }

  console.log('[sck-capture] spawning:', helperPath, args.join(' '));

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.error('[sck-capture] start timed out after 5s');
      if (sckProcess) { sckProcess.kill(); sckProcess = null; }
      resolve({ ok: false, error: 'Native capture start timed out' });
    }, 5000);

    sckProcess = spawn(helperPath, args);
    sckProcess._tempDir = tempDir;
    sckProcess._outputPath = outputPath;

    let stderrBuf = '';
    sckProcess.stderr.on('data', (data) => {
      const text = data.toString();
      console.log('[sck-capture] stderr:', text.trim());
      stderrBuf += text;
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.status === 'recording') {
            clearTimeout(timeout);
            resolve({ ok: true, width: msg.width, height: msg.height, outputPath });
          } else if (msg.status === 'error') {
            clearTimeout(timeout);
            sckProcess = null;
            resolve({ ok: false, error: msg.message });
          }
        } catch {}
      }
    });

    sckProcess.on('error', (err) => {
      clearTimeout(timeout);
      sckProcess = null;
      resolve({ ok: false, error: err.message });
    });

    sckProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && sckProcess) {
        sckProcess = null;
        resolve({ ok: false, error: `Helper exited with code ${code}` });
      }
    });
  });
});

ipcMain.handle('sck-capture:stop', async () => {
  if (!sckProcess) return { ok: false, error: 'No capture in progress' };

  const proc = sckProcess;
  const outputPath = proc._outputPath;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      sckProcess = null;
      resolve({ ok: false, error: 'Shutdown timed out' });
    }, 10000);

    let stderrBuf = '';
    proc.stderr.on('data', (data) => {
      stderrBuf += data.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.status === 'done') {
            clearTimeout(timeout);
            sckProcess = null;
            resolve({ ok: true, outputPath, duration: msg.duration });
          } else if (msg.status === 'error') {
            clearTimeout(timeout);
            sckProcess = null;
            resolve({ ok: false, error: msg.message });
          }
        } catch {}
      }
    });

    proc.kill('SIGTERM');
  });
});

app.on('window-all-closed', () => {
  if (sckProcess) {
    sckProcess.kill('SIGTERM');
  }
  app.quit();
});
