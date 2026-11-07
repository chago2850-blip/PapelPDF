// Puente seguro entre la interfaz y el sistema. Solo expone lo necesario.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('papel', {
  openDialog: (multi = false) => ipcRenderer.invoke('open-dialog', { multi }),
  openImages: () => ipcRenderer.invoke('open-images'),
  chooseFolder: (title) => ipcRenderer.invoke('choose-folder', { title }),
  writeInto: (folder, name, bytes) => ipcRenderer.invoke('write-into', { folder, name, bytes }),
  readPath: (p) => ipcRenderer.invoke('read-path', p),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  recents: () => ipcRenderer.invoke('recents'),
  clearRecents: () => ipcRenderer.invoke('clear-recents'),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  printPdf: (bytes) => ipcRenderer.invoke('print-pdf', bytes),
  qpdf: (opts) => ipcRenderer.invoke('qpdf', opts),
  makeDocx: (opts) => ipcRenderer.invoke('make-docx', opts),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  confirm: (opts) => ipcRenderer.invoke('confirm', opts),
  appInfo: () => ipcRenderer.invoke('app-info'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
  onOpenPath: (fn) => ipcRenderer.on('open-path', (_e, p) => fn(p)),
});
