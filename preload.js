'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Only the EvoTron desktop window gets this; browsers and phones never do.
contextBridge.exposeInMainWorld('evotronDesktop', { resetPassword: () => ipcRenderer.invoke('evotron:reset-password') });
