const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorApp', {
  platform: process.platform,
  version: process.versions.electron,
  voice: {
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    commit: () => ipcRenderer.invoke('voice:commit'),
    sendAudio: (audio) => {
      if (audio instanceof ArrayBuffer) {
        ipcRenderer.send('voice:audio', audio);
        return true;
      } else if (ArrayBuffer.isView(audio)) {
        ipcRenderer.send('voice:audio', audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
        return true;
      }
      return false;
    }
  }
});
