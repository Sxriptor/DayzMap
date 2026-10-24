// Global shortcuts work while another app (e.g. DayZ) has focus. Numpad keys need Num Lock on.
const SHORTCUTS = {
  toggle: ['Show / hide', 'Control+Alt+M'],
  clickThrough: ['Click-through', 'Control+Alt+T'],
  locate: ['Where am I (new spot)', 'Control+Alt+L'],
  locateMore: ['Where am I (add a view from the same spot)', 'Control+Alt+Shift+L'],
  up: ['Pan up', 'num8'],
  left: ['Pan left', 'num4'],
  right: ['Pan right', 'num6'],
  down: ['Pan down', 'num2'],
  rotateLeft: ['Rotate counterclockwise', 'num1'],
  rotateRight: ['Rotate clockwise', 'num3'],
  zoomIn: ['Zoom in', 'num9'],
  zoomOut: ['Zoom out', 'num7']
};
// Commands forwarded to the map page; bound only while the map is visible so the numpad stays free in game.
const MAP_COMMANDS = ['up', 'left', 'right', 'down', 'rotateLeft', 'rotateRight', 'zoomIn', 'zoomOut'];
const finite = v => typeof v === 'number' && Number.isFinite(v);
function sanitize(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const b = value.bounds;
  return {
    alwaysOnTop: value.alwaysOnTop !== false,
    unloadHidden: value.unloadHidden !== false,
    opacity: Math.max(0.4, Math.min(1, Number(value.opacity) || 1)),
    bounds: b && [b.x, b.y, b.width, b.height].every(finite) && b.width >= 300 && b.height >= 200
      ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : undefined
  };
}
module.exports = { SHORTCUTS, MAP_COMMANDS, sanitize };
