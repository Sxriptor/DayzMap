const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  close: () => ipcRenderer.send('close'),
  onCommand: callback => ipcRenderer.on('command', (_, name) => callback(name))
});
