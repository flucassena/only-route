const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  list: () => ipcRenderer.invoke('list'),
  password: (id) => ipcRenderer.invoke('password', id),
  state: () => ipcRenderer.invoke('state'),
  connect: (id, password) => ipcRenderer.invoke('connect', id, password),
  code: (code) => ipcRenderer.invoke('code', code),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  dismiss: () => ipcRenderer.invoke('dismiss'),
  save: (vpn) => ipcRenderer.invoke('save', vpn),
  remove: (id) => ipcRenderer.invoke('delete', id),
  importFile: () => ipcRenderer.invoke('import'),
  hostsRemove: () => ipcRenderer.invoke('hosts-remove'),
  hostsStatus: () => ipcRenderer.invoke('hosts-status'),
  hostsApply: () => ipcRenderer.invoke('hosts-apply'),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
});
