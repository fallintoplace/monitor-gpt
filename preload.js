const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('monitorApp', {
  platform: process.platform,
  version: process.versions.electron
});
