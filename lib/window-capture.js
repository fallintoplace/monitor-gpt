function validBounds(bounds) {
  return bounds
    && ['x', 'y', 'width', 'height'].every((field) => Number.isFinite(bounds[field]))
    && bounds.width > 0
    && bounds.height > 0;
}

function rectanglesIntersect(first, second) {
  if (!validBounds(first) || !validBounds(second)) return false;
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

function visibleWindowsOnDisplay(windows, targetDisplayId, getDisplayMatching, targetBounds = null) {
  const useIntersection = validBounds(targetBounds);
  return windows.filter((window) => {
    if (!window || window.isDestroyed() || !window.isVisible()) return false;
    if (!targetDisplayId) return true;
    try {
      const bounds = window.getBounds();
      if (useIntersection && rectanglesIntersect(bounds, targetBounds)) return true;
      const display = getDisplayMatching(bounds);
      return String(display?.id) === String(targetDisplayId);
    } catch {
      return true;
    }
  });
}

module.exports = { rectanglesIntersect, visibleWindowsOnDisplay };
