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
const {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WINDOW_NAMES,
  loadWindowState,
  normalizeBounds,
  saveWindowState
} = require('./lib/window-state');
const { RealtimeVoiceSession } = require('./lib/voice-session');

let controlWindow;
let resultWindow;
let previousResultWindow;
let voiceResultWindow;
let localServer;
let localPort;
let runner;
let registeredAccelerators = [];
let positionedResultDisplayKey = null;
let positionedPreviousResultDisplayKey = null;
let positionedVoiceResultDisplayKey = null;
let voiceIpcRegistered = false;
let voicePermissionConfigured = false;
let windowStateDirectory;
let persistedWindowState = {};
let windowStateSaveTimer = null;

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

function displayForPreviousResult() {
  return runner?.findPreviousResultDisplay() || null;
}

function displayForVoiceResult() {
  return runner?.findVoiceResultDisplay() || getDisplayList()[0] || null;
}

function normalBoundsForWindow(window) {
  if (!window || window.isDestroyed()) return null;

  try {
    const useNormalBounds = window.isMaximized() || window.isFullScreen();
    return normalizeBounds(useNormalBounds ? window.getNormalBounds() : window.getBounds());
  } catch {
    return null;
  }
}

function numericDisplayBounds(display) {
  const bounds = display?.bounds;
  if (!bounds || ['x', 'y', 'width', 'height'].some((field) => !Number.isFinite(bounds[field]))) {
    return null;
  }

  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  };
}

function clampBoundsToDisplay(bounds, display) {
  const target = numericDisplayBounds(display);
  const source = normalizeBounds(bounds);
  if (!target || !source || target.width <= 0 || target.height <= 0) return target;

  const width = Math.min(Math.max(source.width, MIN_WINDOW_WIDTH), target.width);
  const height = Math.min(Math.max(source.height, MIN_WINDOW_HEIGHT), target.height);
  const maxX = target.x + target.width - width;
  const maxY = target.y + target.height - height;

  return {
    x: Math.min(Math.max(source.x, target.x), maxX),
    y: Math.min(Math.max(source.y, target.y), maxY),
    width,
    height
  };
}

function centerBoundsOnDisplay(bounds, display) {
  const target = numericDisplayBounds(display);
  if (!target || !bounds) return bounds;

  return {
    x: Math.round(target.x + (target.width - bounds.width) / 2),
    y: Math.round(target.y + (target.height - bounds.height) / 2),
    width: bounds.width,
    height: bounds.height
  };
}

function displayForSavedWindow(record) {
  let displays = [];
  try {
    displays = screen.getAllDisplays();
  } catch {
    return null;
  }

  if (record?.displayId) {
    const savedDisplay = displays.find((display) => String(display.id) === String(record.displayId));
    if (savedDisplay) return savedDisplay;
  }

  if (record?.bounds) {
    try {
      return screen.getDisplayMatching(record.bounds);
    } catch {}
  }

  try {
    return screen.getPrimaryDisplay() || displays[0] || null;
  } catch {
    return displays[0] || null;
  }
}

function displayForWindowBounds(bounds, displayId = '') {
  try {
    const displays = screen.getAllDisplays();
    const matchingId = displays.find((display) => displayId && String(display.id) === String(displayId));
    if (matchingId) return matchingId;
    return screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay() || displays[0] || null;
  } catch {
    return null;
  }
}

function saveWindowStateSoon() {
  if (!windowStateDirectory || windowStateSaveTimer) return;

  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    try {
      persistedWindowState = saveWindowState(windowStateDirectory, persistedWindowState);
    } catch (error) {
      console.warn('Could not save window state:', error.message);
    }
  }, 100);
}

function rememberWindowBounds(name, window, displayId = '', knownBounds = null) {
  if (!WINDOW_NAMES.includes(name)) return;
  const bounds = knownBounds ? normalizeBounds(knownBounds) : normalBoundsForWindow(window);
  if (!bounds) return;

  const display = displayForWindowBounds(bounds, displayId);
  persistedWindowState[name] = {
    displayId: display ? String(display.id) : String(displayId || ''),
    bounds
  };
  saveWindowStateSoon();
}

function flushWindowState() {
  if (!windowStateDirectory) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = null;

  rememberWindowBounds('control', controlWindow);
  rememberWindowBounds('result', resultWindow);
  rememberWindowBounds('previous', previousResultWindow);
  rememberWindowBounds('voice', voiceResultWindow);

  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = null;
  try {
    persistedWindowState = saveWindowState(windowStateDirectory, persistedWindowState);
  } catch (error) {
    console.warn('Could not save window state:', error.message);
  }
}

function bindWindowBounds(name, window) {
  if (!window) return;
  const remember = () => rememberWindowBounds(name, window);
  for (const event of ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'close']) {
    window.on(event, remember);
  }
}

function restoreControlWindow() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  const saved = persistedWindowState.control;
  if (!saved) return;

  const display = displayForSavedWindow(saved);
  const bounds = clampBoundsToDisplay(saved.bounds, display);
  if (!bounds) return;
  controlWindow.setBounds(bounds, false);
  rememberWindowBounds('control', controlWindow, display?.id, bounds);
}

function boundsForPositionedWindow(name, display) {
  const displayBounds = numericDisplayBounds(display);
  if (!displayBounds) return null;

  const saved = persistedWindowState[name];
  if (!saved) return displayBounds;

  const savedBounds = clampBoundsToDisplay(saved.bounds, display);
  if (!savedBounds) return displayBounds;
  if (String(saved.displayId) === String(display.id)) return savedBounds;
  return centerBoundsOnDisplay(savedBounds, display);
}

function positionWindowOnDisplay(name, window, display) {
  if (!window || window.isDestroyed() || !display) return;
  const bounds = boundsForPositionedWindow(name, display);
  if (!bounds) return;
  window.setBounds(bounds, false);
  rememberWindowBounds(name, window, display.id, bounds);
}

function positionResultWindow() {
  if (!resultWindow || resultWindow.isDestroyed()) return;
  const display = displayForResult();
  if (!display) return;
  const displayKey = displayBoundsKey(display);
  if (displayKey === positionedResultDisplayKey) return;
  positionWindowOnDisplay('result', resultWindow, display);
  positionedResultDisplayKey = displayKey;
}

function positionPreviousResultWindow() {
  if (!previousResultWindow || previousResultWindow.isDestroyed()) return;
  const previousDisplaySetting = String(runner?.snapshot?.().settings?.previousResultDisplayId || 'auto');
  const display = displayForPreviousResult();
  if (!display) {
    if (previousDisplaySetting === 'off') {
      previousResultWindow.hide();
      positionedPreviousResultDisplayKey = null;
      return;
    }
    if (positionedPreviousResultDisplayKey !== 'window-only' || !previousResultWindow.isVisible()) {
      const saved = persistedWindowState.previous;
      if (saved) {
        const savedDisplay = displayForSavedWindow(saved);
        const bounds = clampBoundsToDisplay(saved.bounds, savedDisplay);
        if (bounds) {
          previousResultWindow.setBounds(bounds, false);
          rememberWindowBounds('previous', previousResultWindow, savedDisplay?.id, bounds);
        }
      }
      positionedPreviousResultDisplayKey = 'window-only';
      previousResultWindow.showInactive();
    }
    return;
  }
  const displayKey = displayBoundsKey(display);
  if (displayKey === positionedPreviousResultDisplayKey) return;
  positionWindowOnDisplay('previous', previousResultWindow, display);
  positionedPreviousResultDisplayKey = displayKey;
  previousResultWindow.showInactive();
}

function positionVoiceResultWindow() {
  if (!voiceResultWindow || voiceResultWindow.isDestroyed()) return;
  const display = displayForVoiceResult();
  if (!display) return;
  const displayKey = displayBoundsKey(display);
  if (displayKey === positionedVoiceResultDisplayKey) return;
  positionWindowOnDisplay('voice', voiceResultWindow, display);
  positionedVoiceResultDisplayKey = displayKey;
}

function restoreWindow(window, shouldShow) {
  if (!window || window.isDestroyed() || !shouldShow) return;
  window.showInactive();
}

async function captureWithoutAppWindows({ displayNumber, maxImageWidth }) {
  const sourceDisplay = getDisplayList().find((display) => display.captureNumber === displayNumber);
  const hiddenWindows = visibleWindowsOnDisplay(
    [controlWindow, resultWindow, previousResultWindow, voiceResultWindow],
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
  ipcMain.handle('voice:commit', () => runner?.commitVoiceAudio() || false);
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
    'End',
    'PageDown'
  ];
  const voice = ['PageUp'];
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
  windowStateDirectory = dataDirectory;
  persistedWindowState = loadWindowState(dataDirectory);
  positionedResultDisplayKey = null;
  positionedPreviousResultDisplayKey = null;
  positionedVoiceResultDisplayKey = null;
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
  previousResultWindow = createWindow({ width: 1280, height: 800, title: 'Monitor GPT · Previous Result' });
  voiceResultWindow = createWindow({ width: 1280, height: 800, title: 'Monitor GPT · Voice' });
  configureMicrophonePermissions(controlWindow);
  await controlWindow.loadURL(`http://127.0.0.1:${localPort}/`);
  await resultWindow.loadURL(`http://127.0.0.1:${localPort}/result`);
  await previousResultWindow.loadURL(`http://127.0.0.1:${localPort}/result?view=previous`);
  await voiceResultWindow.loadURL(`http://127.0.0.1:${localPort}/voice`);
  restoreControlWindow();
  positionResultWindow();
  positionVoiceResultWindow();
  bindWindowBounds('control', controlWindow);
  bindWindowBounds('result', resultWindow);
  bindWindowBounds('previous', previousResultWindow);
  bindWindowBounds('voice', voiceResultWindow);
  controlWindow.show();
  resultWindow.showInactive();
  voiceResultWindow.showInactive();
  positionPreviousResultWindow();

  runner.subscribe((snapshot) => {
    if (snapshot.settings.resultDisplayId) positionResultWindow();
    positionPreviousResultWindow();
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

app.on('before-quit', flushWindowState);

app.on('will-quit', () => {
  flushWindowState();
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
