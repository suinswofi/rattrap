// Bridge between the sandboxed renderer and the main process. Only these calls exist.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bouncer', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: patch => ipcRenderer.invoke('config:set', patch),
  rooms: () => ipcRenderer.invoke('rooms:list'),
  addRoom: name => ipcRenderer.invoke('rooms:add', name),
  removeRoom: name => ipcRenderer.invoke('rooms:remove', name),
  reconnectRoom: name => ipcRenderer.invoke('rooms:reconnect', name),
  snapshot: room => ipcRenderer.invoke('room:snapshot', room),
  detail: (room, id) => ipcRenderer.invoke('room:detail', room, id),
  log: room => ipcRenderer.invoke('room:log', room),
  chat: room => ipcRenderer.invoke('room:chat', room),
  flags: room => ipcRenderer.invoke('room:flags', room),
  save: room => ipcRenderer.invoke('room:save', room),
  editList: (room, list, op, names) => ipcRenderer.invoke('list:edit', room, list, op, names),
  openData: () => ipcRenderer.invoke('open:data'),
  openExternal: url => ipcRenderer.invoke('open:external', url),
  onEvent: cb => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on('bouncer:event', handler);
    return () => ipcRenderer.removeListener('bouncer:event', handler);
  },
});
