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
  // Map tabs in the title bar ("Frostline (Sakhal)" shows as "Frostline").
  const tabs = document.getElementById('mapTabs');
  tabs.hidden = list.length < 2;
  for (const entry of list) {
    const tab = document.createElement('button'); tab.type = 'button'; tab.setAttribute('role', 'tab');
    tab.textContent = entry.name.replace(/\s*\(.*\)$/, ''); tab.title = entry.name;
    tab.setAttribute('aria-selected', String(entry.id === id));
    tab.addEventListener('click', () => {
      if (entry.id === id) return;
      try { localStorage.setItem('map', JSON.stringify(entry.id)); } catch {}
      if (window.desk?.reload) window.desk.reload(); else location.reload();
    });
    tabs.append(tab);
  }
  // Light / dark theme (dark by default, like Whispra), remembered across maps.
  const root = document.documentElement;
  try { if (JSON.parse(localStorage.getItem('theme')) === 'light') root.dataset.theme = 'light'; } catch {}
  document.getElementById('theme').addEventListener('click', () => {
    if (root.dataset.theme === 'light') delete root.dataset.theme; else root.dataset.theme = 'light';
    try { localStorage.setItem('theme', JSON.stringify(root.dataset.theme || 'dark')); } catch {}
  });
  document.getElementById('minimize').addEventListener('click', () => window.desk?.minimize?.());
  document.getElementById('minimize').hidden = !window.desk?.minimize;
  for (const src of [`${id}/data.js`, 'loot.js', 'pins.js', 'map.js', 'server.js']) {
    const s = document.createElement('script'); s.src = src; s.async = false; document.body.append(s);
  }
})();
