/* A fixed, narrow bridge: no Node objects, filesystem, URLs or arbitrary IPC. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nixampLanguage', {
  get: () => ipcRenderer.invoke('nixamp:language-get'),
  set: code => ipcRenderer.invoke('nixamp:language-set', code),
  subscribe: listener => {
    ipcRenderer.on('nixamp:language-changed', (_event, code) => listener(code));
  },
});
