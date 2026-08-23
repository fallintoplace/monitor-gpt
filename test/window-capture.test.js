const test = require('node:test');
const assert = require('node:assert/strict');
const { visibleWindowsOnDisplay } = require('../lib/window-capture');

function fakeWindow({ displayId, visible = true, destroyed = false }) {
  return {
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    getBounds: () => ({ displayId })
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
