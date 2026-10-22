// Saved user pins and shared pointer controls for the 2D and 3D canvases.
(function (root) {
  function createStore(size, saved, persist, changed = () => {}) {
    const valid = p => p && typeof p.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.z) && p.x >= 0 && p.x <= size && p.z >= 0 && p.z <= size;
    let points = Array.isArray(saved) ? saved.filter(valid).filter((p, i, all) => all.findIndex(q => q.id === p.id) === i).map(p => ({ id: p.id, x: p.x, z: p.z })) : [];
    const notify = () => { persist(points.map(p => ({ ...p }))); changed(); };
    return {
      get points() { return points; },
      add(x, z) {
        if (!valid({ id: '', x, z })) return null;
        const point = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`, x, z };
        points.push(point); notify(); return point;
      },
      move(id, x, z) {
        const point = points.find(p => p.id === id);
        if (!point || !valid({ id, x, z })) return false;
        point.x = x; point.z = z; notify(); return true;
      },
      remove(id) { points = points.filter(p => p.id !== id); notify(); }
    };
  }
  function createTapper() {
    let previous = null;
    return {
      reset() { previous = null; },
      tap(x, y, time) {
        const double = previous && time - previous.time <= 350 && Math.hypot(x - previous.x, y - previous.y) <= 24;
        previous = double ? null : { x, y, time }; return !!double;
      }
    };
  }
  function mount({ size, saved, persist, onChange }) {
    const overlay = document.getElementById('userPins'), panel = document.getElementById('pinPanel');
    const label = document.getElementById('pinCoordinates'), hint = document.getElementById('pinHint');
    const buttons = new Map(), tapper = createTapper();
    let selected = null, moving = false, projection = null, unproject = null, drag = null;
    const store = createStore(size, saved, persist, sync);
    function sync() {
      for (const [id, button] of buttons) if (!store.points.some(p => p.id === id)) { button.remove(); buttons.delete(id); }
      for (const point of store.points) if (!buttons.has(point.id)) {
        const button = document.createElement('button'); button.className = 'user-pin'; button.type = 'button';
        button.setAttribute('aria-label', 'Saved point: click to edit or drag to move');
        button.title = 'Click to edit Â- Drag to move';
        button.addEventListener('pointerdown', e => {
          if (e.button !== 0 || !e.isPrimary) return;
          e.preventDefault(); e.stopPropagation(); tapper.reset();
          const anchor = projection?.(point.x, point.z) || [e.clientX, e.clientY];
          drag = { offset: [anchor[0] - e.clientX, anchor[1] - e.clientY], id: point.id, x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId, old: [point.x, point.z] };
          button.setPointerCapture(e.pointerId);
        });
        button.addEventListener('pointermove', e => {
          if (!drag || drag.id !== point.id || drag.pointer !== e.pointerId) return;
          if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) drag.moved = true;
          if (drag.moved) {
            const world = unproject?.(e.clientX + drag.offset[0], e.clientY + drag.offset[1]); if (world) store.move(point.id, ...world);
          }
        });
        const finish = e => {
          if (!drag || drag.id !== point.id || drag.pointer !== e.pointerId) return;
          if (e.type === 'pointercancel') store.move(point.id, ...drag.old);
          else choose(point.id);
          drag = null; if (button.hasPointerCapture(e.pointerId)) button.releasePointerCapture(e.pointerId);
        };
        button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
        button.addEventListener('click', e => { if (e.detail === 0) choose(point.id); });
        buttons.set(point.id, button); overlay.append(button);
      }
      updatePanel(); if (projection) render(projection, unproject); onChange();
    }
    function updatePanel() {
      const point = store.points.find(p => p.id === selected); panel.hidden = !point;
      if (point) label.textContent = `Point Â- X ${Math.round(point.x)} Â- Y ${Math.round(point.z)}`;
      hint.textContent = moving ? 'Click the map to move this point. Esc to cancel.' : 'Drag the pin to move it.';
      document.getElementById('movePin').setAttribute('aria-pressed', String(moving));
      for (const [id, button] of buttons) button.classList.toggle('selected', id === selected);
    }
    function choose(id) { selected = id; moving = false; updatePanel(); }
    document.getElementById('deletePin').addEventListener('click', () => { const id = selected; selected = null; moving = false; store.remove(id); });
    document.getElementById('movePin').addEventListener('click', () => { moving = !moving; tapper.reset(); updatePanel(); });
    document.getElementById('closePin').addEventListener('click', () => choose(null));
    addEventListener('keydown', e => {
      if (e.key === 'Escape') choose(null);
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault(); const id = selected; selected = null; moving = false; store.remove(id);
      }
    });
    function render(project, toWorld) {
      projection = project; unproject = toWorld;
      for (const point of store.points) {
        const screen = project(point.x, point.z), button = buttons.get(point.id);
        button.hidden = !screen || !Number.isFinite(screen[0]) || !Number.isFinite(screen[1]) || screen[0] < -32 || screen[1] < -32 || screen[0] > innerWidth + 32 || screen[1] > innerHeight + 32;
        if (!button.hidden) button.style.transform = `translate(${screen[0]}px, ${screen[1]}px)`;
      }
    }
    function bindMap(canvas, toWorld) {
      let down = null;
      canvas.addEventListener('dblclick', e => e.preventDefault());
      canvas.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !e.isPrimary) { down = null; tapper.reset(); return; }
        down = { x: e.clientX, y: e.clientY, pointer: e.pointerId, moved: false, moving };
        if (moving) { e.stopImmediatePropagation(); canvas.setPointerCapture(e.pointerId); }
      }, true);
      canvas.addEventListener('pointermove', e => {
        if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down.moved = true; tapper.reset(); }
        if (down?.moving) e.stopImmediatePropagation();
      }, true);
      canvas.addEventListener('pointerup', e => {
        const start = down; down = null;
        if (!start || start.pointer !== e.pointerId) return;
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) { start.moved = true; tapper.reset(); }
        if (start.moving) { e.stopImmediatePropagation(); if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId); }
        if (start.moved) return;
        if (start.moving || tapper.tap(e.clientX, e.clientY, e.timeStamp)) {
          const world = toWorld(e.clientX, e.clientY); if (!world) return;
          if (start.moving) { if (store.move(selected, ...world)) { moving = false; updatePanel(); } }
          else { const point = store.add(...world); if (point) choose(point.id); }
        }
      }, true);
      canvas.addEventListener('pointercancel', () => { down = null; tapper.reset(); }, true);
      canvas.addEventListener('wheel', () => tapper.reset(), true);
    }
    sync();
    return { bindMap, render, cancel() { choose(null); tapper.reset(); }, store };
  }
  const api = { createStore, createTapper, mount };
  if (typeof module !== 'undefined') module.exports = api; else root.MapPins = api;
})(typeof window !== 'undefined' ? window : globalThis);
