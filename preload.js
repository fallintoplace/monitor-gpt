const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('monitorApp', {
  platform: process.platform,
  version: process.versions.electron,
  voice: {
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    commit: () => ipcRenderer.invoke('voice:commit'),
    onToggleRequested: (callback) => {
      if (typeof callback !== 'function') return () => {};
      const listener = () => callback();
      ipcRenderer.on('voice:toggle-request', listener);
      return () => ipcRenderer.removeListener('voice:toggle-request', listener);
    },
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
