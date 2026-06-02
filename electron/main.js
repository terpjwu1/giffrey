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
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
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

ipcMain.handle('mp4-export:start', async (event, request) => {
  if (activeExportJob) {
    return { ok: false, error: { code: 'transcode_failed', message: 'An export is already in progress', recoverable: true } };
  }

  const { webm, trim, crop, source, suggestedFilename } = request;

  const saveResult = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('desktop'), suggestedFilename),
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return { ok: false, error: { code: 'cancelled', message: 'Save cancelled', recoverable: true } };
  }

  const ffmpegPath = resolveFFmpegPath(app.isPackaged, process.resourcesPath);
  const validation = await validateFFmpeg(ffmpegPath);
  if (!validation.valid) {
    return { ok: false, error: validation.error };
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
    const code = err.code === 'ENOSPC' ? 'disk_full' : 'write_failed';
    return { ok: false, error: { code, message: `Failed to write temp file: ${err.message}`, recoverable: true } };
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
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    activeExportJob = null;
  }
});

ipcMain.handle('mp4-export:cancel', async () => {
  const hadActiveJob = !!activeExportJob;
  if (activeExportJob) {
    activeExportJob.cancel();
  }
  return { ok: true, cancelled: hadActiveJob };
});

app.on('window-all-closed', () => {
  app.quit();
});
