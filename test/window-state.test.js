const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadWindowState,
  normalizeBounds,
  normalizeWindowState,
  saveWindowState,
  windowStatePath
} = require('../lib/window-state');

function makeTemporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-gpt-window-state-'));
}

function removeTemporaryDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

test('should persist and load bounds for supported windows', () => {
  const directory = makeTemporaryDirectory();
  try {
    const state = {
      control: { displayId: 1, bounds: { x: 10, y: 20, width: 1280, height: 980 } },
      result: { displayId: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
      previous: { displayId: 4, bounds: { x: 3840, y: 0, width: 1280, height: 800 } },
      voice: { displayId: 3, bounds: { x: 1920, y: 0, width: 1280, height: 800 } },
      'voice-memory': { displayId: 3, bounds: { x: 3212, y: 0, width: 1280, height: 800 } },
      ignored: { displayId: 4, bounds: { x: 0, y: 0, width: 1280, height: 800 } }
    };

    saveWindowState(directory, state);

    assert.deepEqual(loadWindowState(directory), {
      control: { displayId: '1', bounds: { x: 10, y: 20, width: 1280, height: 980 } },
      result: { displayId: '2', bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
      previous: { displayId: '4', bounds: { x: 3840, y: 0, width: 1280, height: 800 } },
      voice: { displayId: '3', bounds: { x: 1920, y: 0, width: 1280, height: 800 } },
      'voice-memory': { displayId: '3', bounds: { x: 3212, y: 0, width: 1280, height: 800 } }
    });
    assert.equal(fs.existsSync(windowStatePath(directory)), true);
  } finally {
    removeTemporaryDirectory(directory);
  }
});

test('should reject invalid or undersized bounds', () => {
  assert.deepEqual(normalizeWindowState({
    control: { bounds: { x: 0, y: 0, width: 519, height: 800 } },
    result: { bounds: { x: 0, y: 0, width: 1280, height: 359 } },
    previous: { bounds: { x: 0, y: 0, width: 1280, height: 359 } },
    voice: { bounds: { x: 0, y: 0, width: 1280, height: 800 } },
    'voice-memory': { bounds: { x: 0, y: 0, width: 1280, height: 800 } },
    ignored: { bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  }), {
    voice: { displayId: '', bounds: { x: 0, y: 0, width: 1280, height: 800 } },
    'voice-memory': { displayId: '', bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  });
  assert.equal(normalizeBounds({ x: 0, y: 0, width: Number.NaN, height: 800 }), null);
});

test('should treat a missing or corrupt state file as empty', () => {
  const directory = makeTemporaryDirectory();
  try {
    assert.deepEqual(loadWindowState(directory), {});
    fs.writeFileSync(windowStatePath(directory), '{not-json', 'utf8');
    assert.deepEqual(loadWindowState(directory), {});
  } finally {
    removeTemporaryDirectory(directory);
  }
});
