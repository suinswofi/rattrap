// Bridge between the sandboxed renderer and the main process. Only these calls exist.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rattrap', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: patch => ipcRenderer.invoke('config:set', patch),
  rooms: () => ipcRenderer.invoke('rooms:list'),
  addRoom: name => ipcRenderer.invoke('rooms:add', name),
  removeRoom: name => ipcRenderer.invoke('rooms:remove', name),
  reconnectRoom: name => ipcRenderer.invoke('rooms:reconnect', name),
  snapshot: room => ipcRenderer.invoke('room:snapshot', room),
  detail: (room, id) => ipcRenderer.invoke('room:detail', room, id),
  log: (room, sid) => ipcRenderer.invoke('room:log', room, sid ?? null),
  flags: room => ipcRenderer.invoke('room:flags', room),
  save: room => ipcRenderer.invoke('room:save', room),
  dismiss: (room, users) => ipcRenderer.invoke('room:dismiss', room, users),
  undismiss: (room, users) => ipcRenderer.invoke('room:undismiss', room, users),
  editList: (room, list, op, names) => ipcRenderer.invoke('list:edit', room, list, op, names),
  openData: () => ipcRenderer.invoke('open:data'),
  openExternal: url => ipcRenderer.invoke('open:external', url),
  updateState: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleases: () => ipcRenderer.invoke('update:open'),
  onEvent: cb => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('rattrap:event', handler);
    return () => ipcRenderer.removeListener('rattrap:event', handler);
  },
});
