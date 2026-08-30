const fs = require('node:fs');
const path = require('node:path');

const MIN_WINDOW_WIDTH = 520;
const MIN_WINDOW_HEIGHT = 360;
const WINDOW_NAMES = Object.freeze(['control', 'result', 'previous', 'voice', 'voice-memory']);

function windowStatePath(dataDirectory) {
  return path.join(dataDirectory, 'window-state.json');
}

function normalizeBounds(value) {
  if (!value || typeof value !== 'object') return null;

  const fields = ['x', 'y', 'width', 'height'];
  if (fields.some((field) => !Number.isFinite(value[field]))) return null;

  const bounds = Object.fromEntries(fields.map((field) => [field, Math.round(value[field])]));
  if (bounds.width < MIN_WINDOW_WIDTH || bounds.height < MIN_WINDOW_HEIGHT) return null;
  return bounds;
}

function normalizeWindowState(value) {
  const windows = value?.windows && typeof value.windows === 'object' ? value.windows : value;
  if (!windows || typeof windows !== 'object') return {};

  return Object.fromEntries(WINDOW_NAMES.flatMap((name) => {
    const record = windows[name];
    const bounds = normalizeBounds(record?.bounds);
    if (!bounds) return [];

    return [[name, {
      displayId: record.displayId == null ? '' : String(record.displayId),
      bounds
    }]];
  }));
}

function loadWindowState(dataDirectory) {
  try {
    return normalizeWindowState(JSON.parse(fs.readFileSync(windowStatePath(dataDirectory), 'utf8')));
  } catch {
    return {};
  }
}

function saveWindowState(dataDirectory, value) {
  const normalized = normalizeWindowState(value);
  const targetPath = windowStatePath(dataDirectory);
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;

  fs.mkdirSync(dataDirectory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ windows: normalized }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }

  return normalized;
}

module.exports = {
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WINDOW_NAMES,
  loadWindowState,
  normalizeBounds,
  normalizeWindowState,
  saveWindowState,
  windowStatePath
};
