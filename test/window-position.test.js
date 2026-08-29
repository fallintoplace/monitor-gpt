const test = require('node:test');
const assert = require('node:assert/strict');
const { displayBoundsKey } = require('../lib/window-position');

test('should return the same key for unchanged display geometry', () => {
  const display = {
    id: 'display-1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }
  };

  assert.equal(displayBoundsKey(display), displayBoundsKey({
    id: 'display-1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }
  }));
});

test('should change the key when the selected display or geometry changes', () => {
  const display = {
    id: 'display-1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }
  };

  assert.notEqual(displayBoundsKey(display), displayBoundsKey({
    id: 'display-2',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 }
  }));
  assert.notEqual(displayBoundsKey(display), displayBoundsKey({
    id: 'display-1',
    bounds: { x: 0, y: 0, width: 1512, height: 982 }
  }));
});

test('should return null when no display is available', () => {
  assert.equal(displayBoundsKey(null), null);
});
