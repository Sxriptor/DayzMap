// Picks the map to show (the last one chosen, else Nasdara, else the first built) from maps.js, which the build
// writes, then loads its data and the viewer in order. MAP_ID / MAP_ROOT tell the viewer where its files are.
// The map menu in the top bar saves the choice and reloads; in the app the main process does the reload, since the
// window blocks page-initiated navigation (location.reload included).
(() => {
  const list = window.MAP_LIST || [];
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('map')); } catch {}
  const id = [saved, 'nasdara'].find(m => list.some(entry => entry.id === m)) || list[0]?.id || 'nasdara';
  window.MAP_ID = id; window.MAP_ROOT = `${id}/`;
  const menu = document.getElementById('mapSelect');
  menu.hidden = list.length < 2;
  for (const entry of list) menu.append(new Option(entry.name, entry.id, false, entry.id === id));
  menu.addEventListener('change', () => {
    try { localStorage.setItem('map', JSON.stringify(menu.value)); } catch {}
    if (window.desk?.reload) window.desk.reload(); else location.reload();
  });
  for (const src of [`${id}/data.js`, 'loot.js', 'pins.js', 'map.js']) {
    const s = document.createElement('script'); s.src = src; s.async = false; document.body.append(s);
  }
})();
