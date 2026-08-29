require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const { captureDisplay } = require('./lib/capture');
const { createLocalServer, listen } = require('./lib/server');
const { loadSettings } = require('./lib/config');
const { LocalMemory } = require('./lib/memory');
const { MonitorRunner } = require('./lib/runner');
const { buildResponsesPayload, requestOpenAI } = require('./lib/openai');
const { visibleWindowsOnDisplay } = require('./lib/window-capture');
const { displayBoundsKey } = require('./lib/window-position');
const { RealtimeVoiceSession } = require('./lib/voice-session');

let controlWindow;
let resultWindow;
let voiceResultWindow;
let localServer;
let localPort;
let runner;
let registeredAccelerators = [];
let positionedResultDisplayKey = null;
let positionedVoiceResultDisplayKey = null;
let voiceIpcRegistered = false;
let voicePermissionConfigured = false;

const publicDirectory = path.join(__dirname, 'public');

function dataDirectoryForApp() {
  return process.env.MONITOR_DATA_DIR || path.join(app.getPath('userData'), 'data');
}

function displayLabel(display, index, primaryId, externalNumber) {
  if (String(display.id) === String(primaryId)) return 'Main display';
  return `External display ${externalNumber}`;
}

function getDisplayList() {
  const allDisplays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  let externalNumber = 0;
  return allDisplays.map((display, index) => ({
    id: String(display.id),
    captureNumber: index + 1,
    label: displayLabel(display, index, primary.id, String(display.id) === String(primary.id) ? 0 : ++externalNumber),
    isPrimary: String(display.id) === String(primary.id),
    bounds: display.bounds,
    width: display.bounds.width,
    height: display.bounds.height,
    scaleFactor: display.scaleFactor
  }));
}

function displayForResult() {
  return runner?.findResultDisplay() || getDisplayList()[0] || null;
}

function displayForVoiceResult() {
  return runner?.findVoiceResultDisplay() || getDisplayList()[0] || null;
}

function positionResultWindow() {
  if (!resultWindow || resultWindow.isDestroyed()) return;
  const display = displayForResult();
  if (!display) return;
  const displayKey = displayBoundsKey(display);
  if (displayKey === positionedResultDisplayKey) return;
  resultWindow.setBounds({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  }, false);
  positionedResultDisplayKey = displayKey;
}

function positionVoiceResultWindow() {
  if (!voiceResultWindow || voiceResultWindow.isDestroyed()) return;
  const display = displayForVoiceResult();
  if (!display) return;
  const displayKey = displayBoundsKey(display);
  if (displayKey === positionedVoiceResultDisplayKey) return;
  voiceResultWindow.setBounds({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  }, false);
  positionedVoiceResultDisplayKey = displayKey;
}

function restoreWindow(window, shouldShow) {
  if (!window || window.isDestroyed() || !shouldShow) return;
  window.showInactive();
}

async function captureWithoutAppWindows({ displayNumber, maxImageWidth }) {
  const sourceDisplay = getDisplayList().find((display) => display.captureNumber === displayNumber);
  const hiddenWindows = visibleWindowsOnDisplay(
    [controlWindow, resultWindow, voiceResultWindow],
    sourceDisplay?.id,
    (bounds) => screen.getDisplayMatching(bounds)
  );
  for (const window of hiddenWindows) window.hide();
  await new Promise((resolve) => setTimeout(resolve, 90));
  try {
    return await captureDisplay({ displayNumber, maxImageWidth });
  } finally {
    for (const window of hiddenWindows) restoreWindow(window, true);
  }
}

function audioBufferFromIpc(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function registerVoiceIpc() {
  if (voiceIpcRegistered) return;
  voiceIpcRegistered = true;
  ipcMain.handle('voice:start', () => runner?.startVoice() || { accepted: false, error: 'The app is still starting.' });
  ipcMain.handle('voice:stop', () => runner?.stopVoice() || { accepted: false, error: 'The app is still starting.' });
  ipcMain.on('voice:audio', (_event, value) => {
    const audio = audioBufferFromIpc(value);
    if (audio) runner?.sendVoiceAudio(audio);
  });
}

function configureMicrophonePermissions(window) {
  if (voicePermissionConfigured || !window) return;
  const localOrigin = `http://127.0.0.1:${localPort}`;
  const windowSession = window.webContents.session;
  const isLocalApp = (webContents, requestingOrigin = '') => {
    const origin = requestingOrigin || webContents?.getURL?.() || '';
    return origin.startsWith(localOrigin);
  };
  windowSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    permission === 'media' && isLocalApp(webContents, requestingOrigin)
  ));
  windowSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isLocalApp(webContents));
  });
  voicePermissionConfigured = true;
}

function createWindow(options) {
  return new BrowserWindow({
    show: false,
    resizable: true,
    minWidth: 520,
    minHeight: 360,
    backgroundColor: '#f5f7fb',
    ...options,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      ...(options.webPreferences || {})
    }
  });
}

function registerGlobalShortcuts() {
  for (const accelerator of registeredAccelerators) globalShortcut.unregister(accelerator);
  registeredAccelerators = [];
  const analysis = [
    'Command+Shift+A',
    'Control+Shift+A',
    'End'
  ];
  const voice = ['PageDown'];
  const registeredAnalysis = [];
  for (const accelerator of analysis) {
    try {
      if (globalShortcut.register(accelerator, () => void runner.triggerAnalysis({ reason: `hotkey:${accelerator}` }))) {
        registeredAnalysis.push(accelerator);
        registeredAccelerators.push(accelerator);
      }
    } catch (error) {
      console.warn(`Could not register ${accelerator}:`, error.message);
    }
  }

  const registeredVoice = [];
  for (const accelerator of voice) {
    try {
      if (globalShortcut.register(accelerator, () => void runner.toggleVoice())) {
        registeredVoice.push(accelerator);
        registeredAccelerators.push(accelerator);
      }
    } catch (error) {
      console.warn(`Could not register ${accelerator}:`, error.message);
    }
  }

  runner.setHotkeys({ analysis: registeredAnalysis, voice: registeredVoice });
}

async function startApp() {
  const dataDirectory = dataDirectoryForApp();
  fs.mkdirSync(dataDirectory, { recursive: true });
  const settings = loadSettings(dataDirectory);
  const memory = new LocalMemory(dataDirectory, { maxEntries: settings.memoryMaxEntries });
  runner = new MonitorRunner({
    dataDirectory,
    settings,
    memory,
    capture: captureWithoutAppWindows,
    apiKeyReady: Boolean(process.env.OPENAI_API_KEY),
    requestOpenAI: async ({ payload }) => requestOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      payload
    })
  });
  runner.setVoiceSession(new RealtimeVoiceSession({
    apiKey: process.env.OPENAI_API_KEY,
    onEvent: (event) => runner.handleVoiceEvent(event),
    onError: (error) => runner.handleVoiceError(error)
  }));

  runner.setDisplays(getDisplayList());
  localServer = createLocalServer({ runner, publicDirectory, memory });
  localPort = await listen(localServer, process.env.MONITOR_PORT || 4317);

  controlWindow = createWindow({ width: 1280, height: 980, title: 'Monitor GPT' });
  resultWindow = createWindow({ width: 1280, height: 800, title: 'Monitor GPT · Result' });
  voiceResultWindow = createWindow({ width: 1280, height: 800, title: 'Monitor GPT · Voice' });
  configureMicrophonePermissions(controlWindow);
  await controlWindow.loadURL(`http://127.0.0.1:${localPort}/`);
  await resultWindow.loadURL(`http://127.0.0.1:${localPort}/result`);
  await voiceResultWindow.loadURL(`http://127.0.0.1:${localPort}/voice`);
  positionResultWindow();
  positionVoiceResultWindow();
  controlWindow.show();
  resultWindow.showInactive();
  voiceResultWindow.showInactive();

  runner.subscribe((snapshot) => {
    if (snapshot.settings.resultDisplayId) positionResultWindow();
    if (snapshot.settings.voiceResultDisplayId) positionVoiceResultWindow();
  });
  registerVoiceIpc();
  registerGlobalShortcuts();
  runner.start();
}

app.whenReady().then(startApp).catch((error) => {
  console.error('Could not start Monitor GPT:', error);
});

app.on('activate', () => {
  if (!controlWindow || controlWindow.isDestroyed()) startApp();
  else controlWindow.show();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  for (const accelerator of registeredAccelerators) globalShortcut.unregister(accelerator);
  registeredAccelerators = [];
  runner?.stop();
  if (localServer) localServer.close();
});

module.exports = {
  displayLabel,
  getDisplayList,
  buildResponsesPayload,
  dataDirectoryForApp
};
