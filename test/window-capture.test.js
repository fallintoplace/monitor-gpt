const test = require('node:test');
const assert = require('node:assert/strict');
const { rectanglesIntersect, visibleWindowsOnDisplay } = require('../lib/window-capture');

function fakeWindow({ displayId, visible = true, destroyed = false }) {
  return {
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    getBounds: () => ({ displayId })
  };
}

function boundedWindow(bounds, options = {}) {
  return {
    isVisible: () => options.visible !== false,
    isDestroyed: () => options.destroyed === true,
    getBounds: () => bounds
  };
}

test('should hide only visible windows on the source display', () => {
  const sourceWindow = fakeWindow({ displayId: 'source' });
  const resultWindow = fakeWindow({ displayId: 'result' });
  const hidden = visibleWindowsOnDisplay(
    [sourceWindow, resultWindow],
    'source',
    (bounds) => ({ id: bounds.displayId })
  );

  assert.deepEqual(hidden, [sourceWindow]);
});

test('should ignore hidden and destroyed windows', () => {
  const hiddenWindow = fakeWindow({ displayId: 'source', visible: false });
  const destroyedWindow = fakeWindow({ displayId: 'source', destroyed: true });

  assert.deepEqual(
    visibleWindowsOnDisplay(
      [hiddenWindow, destroyedWindow],
      'source',
      (bounds) => ({ id: bounds.displayId })
    ),
    []
  );
});

test('should hide visible windows when the source display cannot be identified', () => {
  const controlWindow = fakeWindow({ displayId: 'control' });
  const resultWindow = fakeWindow({ displayId: 'result' });

  assert.deepEqual(
    visibleWindowsOnDisplay([controlWindow, resultWindow], undefined, () => null),
    [controlWindow, resultWindow]
  );
});

test('should detect any positive rectangle overlap', () => {
  assert.equal(rectanglesIntersect(
    { x: 90, y: 10, width: 20, height: 20 },
    { x: 0, y: 0, width: 100, height: 100 }
  ), true);
  assert.equal(rectanglesIntersect(
    { x: 100, y: 10, width: 20, height: 20 },
    { x: 0, y: 0, width: 100, height: 100 }
  ), false);
});

test('should hide a visible window that partially overlaps the source display', () => {
  const spanningWindow = boundedWindow({ x: 90, y: 10, width: 20, height: 20 });

  assert.deepEqual(
    visibleWindowsOnDisplay(
      [spanningWindow],
      'source',
      () => ({ id: 'other-display' }),
      { x: 0, y: 0, width: 100, height: 100 }
    ),
    [spanningWindow]
  );
});
