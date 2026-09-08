const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('m0', Object.freeze({
  getState: () => ipcRenderer.invoke('m0:get-state'),
  command: command => ipcRenderer.invoke('m0:command', command),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('m0:state', listener);
    return () => ipcRenderer.removeListener('m0:state', listener);
  }
}));
