require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } = require('electron');
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
let voiceMemoryResultWindow;
let combinedResultWindow;
let localServer;
let localPort;
let localApiToken;
let runner;
let backendStartPromise = null;
let windowsStartPromise = null;
let registeredAccelerators = [];
let registeredTriggerMode = null;
let positionedResultDisplayKey = null;
let positionedPreviousResultDisplayKey = null;
let positionedVoiceResultDisplayKey = null;
let positionedVoiceMemoryResultDisplayKey = null;
let positionedCombinedResultDisplayKey = null;
let voiceIpcRegistered = false;
let voicePermissionConfigured = false;
let localRequestHeadersConfigured = false;
let displayEventsRegistered = false;
let displayRefreshTimer = null;
let shuttingDown = false;
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

function displayForCombinedResult() {
  return runner?.findCombinedResultDisplay() || getDisplayList()[0] || null;
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
  rememberWindowBounds('voice-memory', voiceMemoryResultWindow);
  rememberWindowBounds('combined', combinedResultWindow);

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
  window.once('closed', () => clearWindowReference(name, window));
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

function voiceTileBounds(display) {
  const target = numericDisplayBounds(display);
  const gap = 12;
  if (!target || target.width < MIN_WINDOW_WIDTH * 2 + gap) return null;

  const width = Math.floor((target.width - gap) / 2);
  return [
    { x: target.x, y: target.y, width, height: target.height },
    { x: target.x + width + gap, y: target.y, width, height: target.height }
  ];
}

function defaultVoiceMemoryBounds(display) {
  const target = numericDisplayBounds(display);
  if (!target) return null;
  return clampBoundsToDisplay({
    x: target.x + Math.round(target.width * 0.4),
    y: target.y + Math.round(target.height * 0.12),
    width: Math.round(target.width * 0.58),
    height: Math.round(target.height * 0.76)
  }, display);
}

function positionVoiceMemoryResultWindow() {
  if (!voiceMemoryResultWindow || voiceMemoryResultWindow.isDestroyed()) return;
  const display = displayForVoiceResult();
  if (!display) return;
  const displayKey = displayBoundsKey(display);
  if (displayKey === positionedVoiceMemoryResultDisplayKey) return;

  const tile = voiceTileBounds(display);
  const displayChanged = Boolean(positionedVoiceMemoryResultDisplayKey)
    && positionedVoiceMemoryResultDisplayKey !== displayKey;
  const shouldTile = Boolean(tile)
    && (!persistedWindowState.voice || !persistedWindowState['voice-memory'] || displayChanged);

  if (shouldTile && voiceResultWindow && !voiceResultWindow.isDestroyed()) {
    const [baselineBounds, memoryBounds] = tile;
    voiceResultWindow.setBounds(baselineBounds, false);
    rememberWindowBounds('voice', voiceResultWindow, display.id, baselineBounds);
    voiceMemoryResultWindow.setBounds(memoryBounds, false);
    rememberWindowBounds('voice-memory', voiceMemoryResultWindow, display.id, memoryBounds);
  } else if (persistedWindowState['voice-memory']) {
    positionWindowOnDisplay('voice-memory', voiceMemoryResultWindow, display);
  } else {
    const bounds = defaultVoiceMemoryBounds(display);
    if (bounds) {
      voiceMemoryResultWindow.setBounds(bounds, false);
      rememberWindowBounds('voice-memory', voiceMemoryResultWindow, display.id, bounds);
    }
  }

  positionedVoiceMemoryResultDisplayKey = displayKey;
  voiceMemoryResultWindow.showInactive();
}

function defaultCombinedResultBounds(display) {
  const target = numericDisplayBounds(display);
  if (!target) return null;
  return clampBoundsToDisplay({
    x: target.x + Math.round(target.width * 0.18),
    y: target.y + Math.round(target.height * 0.14),
    width: Math.round(target.width * 0.64),
    height: Math.round(target.height * 0.72)
  }, display);
}

function positionCombinedResultWindow() {
  if (!combinedResultWindow || combinedResultWindow.isDestroyed()) return;
  const display = displayForCombinedResult();
  if (!display) return;
  const displayKey = displayBoundsKey(display);
  if (displayKey === positionedCombinedResultDisplayKey) return;

  if (persistedWindowState.combined) {
    positionWindowOnDisplay('combined', combinedResultWindow, display);
  } else {
    const bounds = defaultCombinedResultBounds(display);
    if (bounds) {
      combinedResultWindow.setBounds(bounds, false);
      rememberWindowBounds('combined', combinedResultWindow, display.id, bounds);
    }
  }
  positionedCombinedResultDisplayKey = displayKey;
}

function restoreWindow(window, shouldShow) {
  if (!window || window.isDestroyed() || !shouldShow) return;
  window.showInactive();
}

async function captureWithoutAppWindows({ displayId, displayNumber, maxImageWidth }) {
  const displays = getDisplayList();
  const sourceDisplay = displayId
    ? displays.find((display) => String(display.id) === String(displayId))
    : displays.find((display) => display.captureNumber === displayNumber);
  if (!sourceDisplay) throw new Error('The selected source display is no longer available. Refresh the display list.');
  const hiddenWindows = visibleWindowsOnDisplay(
    [controlWindow, resultWindow, previousResultWindow, voiceResultWindow, voiceMemoryResultWindow, combinedResultWindow],
    sourceDisplay?.id,
    (bounds) => screen.getDisplayMatching(bounds),
    sourceDisplay?.bounds
  );
  for (const window of hiddenWindows) window.hide();
  await new Promise((resolve) => setTimeout(resolve, 90));
  try {
    return await captureDisplay({
      displayId: sourceDisplay?.id,
      displayNumber: sourceDisplay?.captureNumber || displayNumber,
      displayWidth: sourceDisplay?.width,
      displayHeight: sourceDisplay?.height,
      scaleFactor: sourceDisplay?.scaleFactor,
      maxImageWidth,
      desktopCapturerImpl: desktopCapturer
    });
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
    try {
      return new URL(origin).origin === localOrigin;
    } catch {
      return false;
    }
  };
  windowSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    permission === 'media' && isLocalApp(webContents, requestingOrigin)
  ));
  windowSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isLocalApp(webContents));
  });
  voicePermissionConfigured = true;
}

function configureLocalRequestHeaders(window) {
  if (localRequestHeadersConfigured || !window || !localPort || !localApiToken) return;
  const windowSession = window.webContents.session;
  const localApiPattern = `http://127.0.0.1:${localPort}/api/*`;
  windowSession.webRequest.onBeforeSendHeaders({ urls: [localApiPattern] }, (details, callback) => {
    details.requestHeaders['X-Monitor-Token'] = localApiToken;
    callback({ requestHeaders: details.requestHeaders });
  });
  localRequestHeadersConfigured = true;
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

function windowForName(name) {
  return {
    control: controlWindow,
    result: resultWindow,
    previous: previousResultWindow,
    voice: voiceResultWindow,
    'voice-memory': voiceMemoryResultWindow,
    combined: combinedResultWindow
  }[name];
}

function setWindowForName(name, window) {
  switch (name) {
    case 'control':
      controlWindow = window;
      break;
    case 'result':
      resultWindow = window;
      break;
    case 'previous':
      previousResultWindow = window;
      break;
    case 'voice':
      voiceResultWindow = window;
      break;
    case 'voice-memory':
      voiceMemoryResultWindow = window;
      break;
    case 'combined':
      combinedResultWindow = window;
      break;
    default:
      break;
  }
}

function clearPositionedDisplayKey(name) {
  switch (name) {
    case 'result':
      positionedResultDisplayKey = null;
      break;
    case 'previous':
      positionedPreviousResultDisplayKey = null;
      break;
    case 'voice':
      positionedVoiceResultDisplayKey = null;
      break;
    case 'voice-memory':
      positionedVoiceMemoryResultDisplayKey = null;
      break;
    case 'combined':
      positionedCombinedResultDisplayKey = null;
      break;
    default:
      break;
  }
}

function clearWindowReference(name, window) {
  if (windowForName(name) !== window) return;
  setWindowForName(name, undefined);
  clearPositionedDisplayKey(name);
  if (name === 'control' && runner) void runner.stopVoice({ graceful: false });
}

function registerGlobalShortcuts() {
  for (const accelerator of registeredAccelerators) globalShortcut.unregister(accelerator);
  registeredAccelerators = [];
  const analysis = runner?.screenHotkeysEnabled?.() ? [
      'Command+Shift+A',
      'Control+Shift+A',
      'End',
      'PageDown'
    ] : [];
  registeredTriggerMode = runner?.snapshot?.().settings?.triggerMode || null;
  const voice = ['Home', 'PageUp'];
  const registeredAnalysis = [];
  for (const accelerator of analysis) {
    try {
      if (globalShortcut.register(accelerator, () => {
        if (runner?.requestAnalysis) runner.requestAnalysis({ reason: `hotkey:${accelerator}` });
        else void runner?.triggerAnalysis({ reason: `hotkey:${accelerator}` });
      })) {
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
      if (globalShortcut.register(accelerator, requestVoiceToggle)) {
        registeredVoice.push(accelerator);
        registeredAccelerators.push(accelerator);
      }
    } catch (error) {
      console.warn(`Could not register ${accelerator}:`, error.message);
    }
  }

  runner.setHotkeys({ analysis: registeredAnalysis, voice: registeredVoice, combined: [] });
}

function requestVoiceToggle() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('voice:toggle-request');
    return;
  }
  if (runner?.snapshot?.().voice?.enabled) void runner.stopVoice({ graceful: false });
}

function registerDisplayEvents() {
  if (displayEventsRegistered) return;
  const scheduleRefresh = () => {
    if (shuttingDown || !runner) return;
    if (displayRefreshTimer) clearTimeout(displayRefreshTimer);
    displayRefreshTimer = setTimeout(() => {
      displayRefreshTimer = null;
      try {
        runner.refreshDisplays();
      } catch (error) {
        console.warn('Could not refresh displays:', error.message);
      }
    }, 120);
  };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, scheduleRefresh);
  }
  displayEventsRegistered = true;
}

function subscribeToRunner() {
  runner.subscribe((snapshot) => {
    if (registeredTriggerMode !== snapshot.settings.triggerMode) registerGlobalShortcuts();
    positionResultWindow();
    positionPreviousResultWindow();
    positionVoiceResultWindow();
    positionVoiceMemoryResultWindow();
    positionCombinedResultWindow();
    if (snapshot.settings.previousResultDisplayId === 'off') previousResultWindow?.hide();
  });
}

async function startBackend() {
  if (runner && localServer && localPort) return;
  if (backendStartPromise) return backendStartPromise;

  let startingRunner;
  let startingServer;
  backendStartPromise = (async () => {
    const dataDirectory = dataDirectoryForApp();
    fs.mkdirSync(dataDirectory, { recursive: true });
    windowStateDirectory = dataDirectory;
    persistedWindowState = loadWindowState(dataDirectory);
    positionedResultDisplayKey = null;
    positionedPreviousResultDisplayKey = null;
    positionedVoiceResultDisplayKey = null;
    positionedVoiceMemoryResultDisplayKey = null;
    positionedCombinedResultDisplayKey = null;
    const settings = loadSettings(dataDirectory);
    const memory = new LocalMemory(dataDirectory, { maxEntries: settings.memoryMaxEntries });
    const nextRunner = new MonitorRunner({
      dataDirectory,
      settings,
      memory,
      capture: captureWithoutAppWindows,
      getDisplays: getDisplayList,
      apiKeyReady: Boolean(process.env.OPENAI_API_KEY),
      requestOpenAI: async ({ payload }) => requestOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        payload
      })
    });
    startingRunner = nextRunner;
    nextRunner.setVoiceSession(new RealtimeVoiceSession({
      apiKey: process.env.OPENAI_API_KEY,
      onEvent: (event) => nextRunner.handleVoiceEvent(event),
      onError: (error) => nextRunner.handleVoiceError(error)
    }));

    nextRunner.setDisplays(getDisplayList());
    const nextApiToken = crypto.randomBytes(32).toString('hex');
    const nextServer = createLocalServer({ runner: nextRunner, publicDirectory, memory, authToken: nextApiToken });
    startingServer = nextServer;
    const nextPort = await listen(nextServer, process.env.MONITOR_PORT || 4317);

    runner = nextRunner;
    localServer = nextServer;
    localPort = nextPort;
    localApiToken = nextApiToken;
    registerVoiceIpc();
    registerGlobalShortcuts();
    registerDisplayEvents();
    subscribeToRunner();
    runner.start();
  })().catch((error) => {
    startingRunner?.stop();
    try { startingServer?.close(); } catch {}
    if (runner === startingRunner) runner = undefined;
    if (localServer === startingServer) localServer = undefined;
    if (localServer === undefined) {
      localPort = undefined;
      localApiToken = undefined;
    }
    throw error;
  }).finally(() => {
    backendStartPromise = null;
  });
  return backendStartPromise;
}

async function ensureWindow({ name, options, route }) {
  const existing = windowForName(name);
  if (existing && !existing.isDestroyed()) return existing;

  const window = createWindow(options);
  setWindowForName(name, window);
  bindWindowBounds(name, window);
  if (name === 'control') {
    configureMicrophonePermissions(window);
    configureLocalRequestHeaders(window);
  }
  try {
    await window.loadURL(`http://127.0.0.1:${localPort}${route}`);
    return window;
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

async function ensureWindows() {
  if (windowsStartPromise) return windowsStartPromise;
  windowsStartPromise = (async () => {
    if (!runner || !localServer || !localPort) await startBackend();
    if (shuttingDown) return;

    if (controlWindow && !controlWindow.isDestroyed()) {
      configureMicrophonePermissions(controlWindow);
      configureLocalRequestHeaders(controlWindow);
    }
    await ensureWindow({ name: 'control', options: { width: 1280, height: 980, title: 'Monitor GPT' }, route: '/' });
    await ensureWindow({ name: 'result', options: { width: 1280, height: 800, title: 'Monitor GPT · Result' }, route: '/result' });
    await ensureWindow({ name: 'previous', options: { width: 1280, height: 800, title: 'Monitor GPT · Previous Result' }, route: '/result?view=previous' });
    await ensureWindow({ name: 'voice', options: { width: 1280, height: 800, title: 'Monitor GPT · Voice' }, route: '/voice' });
    await ensureWindow({ name: 'voice-memory', options: { width: 1280, height: 800, title: 'Monitor GPT · Voice Memory' }, route: '/voice?view=memory' });
    await ensureWindow({ name: 'combined', options: { width: 1280, height: 800, title: 'Monitor GPT · Combined' }, route: '/voice?view=combined' });

    restoreControlWindow();
    positionResultWindow();
    positionPreviousResultWindow();
    positionVoiceResultWindow();
    positionVoiceMemoryResultWindow();
    positionCombinedResultWindow();
    controlWindow?.show();
    resultWindow?.showInactive();
    voiceResultWindow?.showInactive();
    voiceMemoryResultWindow?.showInactive();
    combinedResultWindow?.showInactive();
    positionPreviousResultWindow();
  })().finally(() => {
    windowsStartPromise = null;
  });
  return windowsStartPromise;
}

async function startApp() {
  if (shuttingDown) return;
  await startBackend();
  await ensureWindows();
}

app.whenReady().then(startApp).catch((error) => {
  console.error('Could not start Monitor GPT:', error);
});

app.on('activate', () => {
  void startApp().catch((error) => {
    console.error('Could not reactivate Monitor GPT:', error);
  });
});

app.on('window-all-closed', () => {
  void runner?.stopVoice({ graceful: false });
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', flushWindowState);

app.on('will-quit', () => {
  shuttingDown = true;
  if (displayRefreshTimer) clearTimeout(displayRefreshTimer);
  displayRefreshTimer = null;
  flushWindowState();
  for (const accelerator of registeredAccelerators) globalShortcut.unregister(accelerator);
  registeredAccelerators = [];
  registeredTriggerMode = null;
  runner?.stop();
  if (localServer) localServer.close();
});

module.exports = {
  displayLabel,
  getDisplayList,
  buildResponsesPayload,
  dataDirectoryForApp
};
