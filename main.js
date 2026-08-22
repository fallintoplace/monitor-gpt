require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const { captureDisplay } = require('./lib/capture');
const { createLocalServer, listen } = require('./lib/server');
const { loadSettings } = require('./lib/config');
const { LocalMemory } = require('./lib/memory');
const { MonitorRunner } = require('./lib/runner');
const { buildResponsesPayload, requestOpenAI } = require('./lib/openai');

let controlWindow;
let resultWindow;
let localServer;
let localPort;
let runner;
let registeredAccelerators = [];

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

function positionResultWindow() {
  if (!resultWindow || resultWindow.isDestroyed()) return;
  const display = displayForResult();
  if (!display) return;
  resultWindow.setBounds({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height
  }, false);
}

function restoreWindow(window, shouldShow) {
  if (!window || window.isDestroyed() || !shouldShow) return;
  window.showInactive();
}

async function captureWithoutAppWindows({ displayNumber, maxImageWidth }) {
  const controlWasVisible = Boolean(controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible());
  const resultWasVisible = Boolean(resultWindow && !resultWindow.isDestroyed() && resultWindow.isVisible());
  controlWindow?.hide();
  resultWindow?.hide();
  await new Promise((resolve) => setTimeout(resolve, 90));
  try {
    return await captureDisplay({ displayNumber, maxImageWidth });
  } finally {
    positionResultWindow();
    restoreWindow(resultWindow, resultWasVisible);
    restoreWindow(controlWindow, controlWasVisible);
  }
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
  const analysis = [
    'Command+Shift+A',
    'Control+Shift+A',
    'PageDown',
    'End'
  ];
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

  runner.setHotkeys({ analysis: registeredAnalysis, voice: [] });
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

  runner.setDisplays(getDisplayList());
  localServer = createLocalServer({ runner, publicDirectory, memory });
  localPort = await listen(localServer, process.env.MONITOR_PORT || 4317);

  controlWindow = createWindow({ width: 1280, height: 980, title: 'Monitor GPT' });
  resultWindow = createWindow({ width: 1280, height: 800, title: 'Monitor GPT · Result' });
  await controlWindow.loadURL(`http://127.0.0.1:${localPort}/`);
  await resultWindow.loadURL(`http://127.0.0.1:${localPort}/result`);
  positionResultWindow();
  controlWindow.show();
  resultWindow.showInactive();

  runner.subscribe((snapshot) => {
    if (snapshot.settings.resultDisplayId) positionResultWindow();
  });
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
