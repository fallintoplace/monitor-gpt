function displayBoundsKey(display) {
  if (!display) return null;
  const bounds = display.bounds || {};
  return [display.id, bounds.x, bounds.y, bounds.width, bounds.height].join(':');
}

module.exports = { displayBoundsKey };
