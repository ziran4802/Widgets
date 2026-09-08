const { contextBridge, ipcRenderer } = require('electron');

function normalizeMove(payload) {
  if (!payload || typeof payload.instanceId !== 'string' || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return null;
  return Object.freeze({ instanceId: payload.instanceId, x: payload.x, y: payload.y });
}

contextBridge.exposeInMainWorld('manager', Object.freeze({
  dispatch: (command, envelope) => ipcRenderer.invoke('manager:dispatch', command, envelope),
  autostart: action => ipcRenderer.invoke('manager:autostart', action),
  onComponentMoved: callback => {
    if (typeof callback !== 'function') throw new TypeError('callback is required');
    const listener = (_event, payload) => {
      const move = normalizeMove(payload);
      if (move) callback(move);
    };
    ipcRenderer.on('manager:component-moved', listener);
    return () => ipcRenderer.removeListener('manager:component-moved', listener);
  }
}));
