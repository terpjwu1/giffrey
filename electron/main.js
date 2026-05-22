const { app, BrowserWindow, protocol, session, ipcMain, dialog, desktopCapturer, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

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

app.on('window-all-closed', () => {
  app.quit();
});
