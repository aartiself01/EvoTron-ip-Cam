'use strict';
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const { createServer } = require('./server');

let ffmpegPath = 'ffmpeg';
try { ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); } catch (e) { /* falls back to ffmpeg on PATH */ }

const PORT = 8080;
let srv = null;

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  srv = createServer({
    dataDir: path.join(app.getPath('userData'), 'evotron-data'),
    ffmpegPath,
    webDir: path.join(__dirname, 'web'),
    port: PORT,
  });
  try { await srv.start(); } catch (e) { console.error('Server failed to start:', e.message); }

  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 900, minHeight: 600,
    title: 'EvoTron IP Camera Monitoring',
    backgroundColor: '#0b1220',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('http://127.0.0.1:' + PORT + '/');
});

app.on('window-all-closed', () => { if (srv) srv.stop(); app.quit(); });
