function visibleWindowsOnDisplay(windows, targetDisplayId, getDisplayMatching) {
  return windows.filter((window) => {
    if (!window || window.isDestroyed() || !window.isVisible()) return false;
    if (!targetDisplayId) return true;
    try {
      const display = getDisplayMatching(window.getBounds());
      return String(display?.id) === String(targetDisplayId);
    } catch {
      return true;
    }
  });
}

module.exports = { visibleWindowsOnDisplay };
