const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback is required');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('widget', Object.freeze({
  onState: callback => subscribe('widget:state', callback),
  onMetrics: callback => subscribe('widget:metrics', callback),
  onCodexQuota: callback => subscribe('widget:codex-quota', callback),
  onEditMode: callback => subscribe('widget:edit-mode', callback),
  drag: (operation, pointerId) => ipcRenderer.invoke('widget:drag', operation, pointerId),
  refreshCodexQuota: () => ipcRenderer.invoke('widget:codex-quota-refresh'),
  saveNote: content => ipcRenderer.invoke('widget:note-save', content),
  updateTodo: state => ipcRenderer.invoke('widget:todo-update', state),
  setTodoInteraction: interactive => ipcRenderer.invoke('widget:todo-interaction', interactive),
  onFlushNote: callback => subscribe('widget:flush-note', callback),
  completeNoteFlush: (requestId, result) => ipcRenderer.send('widget:note-flush-complete', requestId, result)
}));
