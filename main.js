'use strict';
const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const { createServer } = require('./server');

let ffmpegPath = 'ffmpeg';
try { ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); } catch (e) { /* falls back to ffmpeg on PATH */ }

const PORT = 8080;
let srv = null;
let win = null;

if (!app.requestSingleInstanceLock()) app.quit();

async function confirmReset() {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Reset password', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Reset password',
    message: 'Reset the EvoTron login password to "admin"?',
    detail: 'All phones and browsers will be logged out. Log in again with "admin" and choose a new password.',
  });
  if (r.response !== 0) return false;
  srv.resetPassword();
  return true;
}

// Called from the "Forgot password?" button on the login screen (only this window can call it).
ipcMain.handle('evotron:reset-password', (e) => {
  if (!e.senderFrame || e.senderFrame.url.indexOf('http://127.0.0.1:' + PORT + '/') !== 0) return false;
  return confirmReset();
});

function buildMenu() {
  const dataDir = path.join(app.getPath('userData'), 'evotron-data');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'EvoTron',
      submenu: [
        {
          label: 'Reset login password to "admin"...',
          click: async () => { if (await confirmReset()) { await dialog.showMessageBox(win, { type: 'info', message: 'The password is now: admin' }); win.reload(); } },
        },
        { label: 'Open data folder', click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
  ]));
}

app.whenReady().then(async () => {
  srv = createServer({
    dataDir: path.join(app.getPath('userData'), 'evotron-data'),
    ffmpegPath,
    webDir: path.join(__dirname, 'web'),
    port: PORT,
  });
  try { await srv.start(); } catch (e) { console.error('Server failed to start:', e.message); }

  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 900, minHeight: 600,
    title: 'EvoTron IP Camera Monitoring',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true, // press Alt to show the menu
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  });
  buildMenu();
  win.loadURL('http://127.0.0.1:' + PORT + '/');
});

app.on('window-all-closed', () => { if (srv) srv.stop(); app.quit(); });
