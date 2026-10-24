const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  close: () => ipcRenderer.send('close'),
  fullscreen: () => ipcRenderer.send('fullscreen'),
  reload: () => ipcRenderer.send('reload'),
  minimize: () => ipcRenderer.send('minimize'),
  onCommand: callback => ipcRenderer.on('command', (_, name) => callback(name)),
  // Where am I (src/locator.js): whether this map has a place index, and a search from a screenshot (image:
  // PNG/JPEG bytes) or, without one, the game window. add: combine with the previous views from this spot.
  places: map => ipcRenderer.invoke('places', map),
  locate: request => ipcRenderer.invoke('locate', request),
  onLocated: callback => ipcRenderer.on('located', (_, result) => callback(result)),
  // Server panel (src/server.js): scan, save(form), start(name), stop(name), join(name), running(), open().
  server: (action, payload) => ipcRenderer.invoke('server', action, payload)
});
