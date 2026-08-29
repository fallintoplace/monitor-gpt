const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorApp', {
  platform: process.platform,
  version: process.versions.electron,
  voice: {
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    sendAudio: (audio) => {
      if (audio instanceof ArrayBuffer) {
        ipcRenderer.send('voice:audio', audio);
      } else if (ArrayBuffer.isView(audio)) {
        ipcRenderer.send('voice:audio', audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
      }
    }
  }
});
