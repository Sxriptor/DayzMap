const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  close: () => ipcRenderer.send('close'),
  fullscreen: () => ipcRenderer.send('fullscreen'),
  reload: () => ipcRenderer.send('reload'),
  onCommand: callback => ipcRenderer.on('command', (_, name) => callback(name))
});
