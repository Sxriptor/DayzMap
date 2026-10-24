const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, nativeImage, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { SHORTCUTS, MAP_COMMANDS, sanitize } = require('./config');
const MAP_PAGE = path.join(__dirname, 'map', 'index.html');
const ICON = path.join(__dirname, 'icon.png');
let win, tray, settings, settingsPath;
let clickThrough = false, loaded = false;
let currentMap = 'nasdara'; // the map the page shows, for the Where am I shortcut
const smoke = process.argv.includes('--smoke');
if (smoke) {
  // A packaged app's folder is a read-only archive, so its smoke profile goes in the temp folder.
  const smokeData = app.isPackaged ? path.join(app.getPath('temp'), 'mapino-smoke-profile') : path.join(__dirname, '..', '.runtime', 'smoke-profile');
  fs.mkdirSync(smokeData, { recursive: true });
  app.setPath('userData', smokeData);
}
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
function save() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch {}
}
function onScreen(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width - 50 && bounds.x + bounds.width > a.x + 50 && bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 50);
}
// The map renderer is released while hidden (when enabled) and reloaded on show; view state lives in the page's storage.
async function loadMap() {
  if (loaded) return;
  loaded = true;
  await win.loadFile(MAP_PAGE).catch(() => {});
}
function unload() {
  if (!loaded || !settings.unloadHidden) return;
  loaded = false;
  win.loadURL('about:blank').catch(() => {});
}
function show(focus = false) {
  loadMap();
  if (win.isMinimized()) win.restore();
  focus ? win.show() : win.showInactive();
  bindMapKeys(true);
}
function hide() { win.hide(); unload(); bindMapKeys(false); }
function toggleClickThrough() {
  clickThrough = !clickThrough;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
}
function register(id, handler) {
  try { if (globalShortcut.register(SHORTCUTS[id][1], handler)) return true; } catch {}
  console.warn(`Shortcut unavailable: ${SHORTCUTS[id][0]} (${SHORTCUTS[id][1]})`);
  return false;
}
// Where am I from the shortcut: the game is captured before Mapino shows (it must not cover the picture),
// then the answer, or why there is none, goes to the page.
let locating = false;
async function locateFromShortcut(add) {
  if (locating) return;
  locating = true;
  let result;
  try { result = await require('./locator').locateRequest({ map: currentMap, add }); }
  catch (error) { result = { error: error.message }; }
  locating = false;
  show();
  const send = () => win.webContents.send('located', result);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', () => setTimeout(send, 500)); else send();
}
function bindMapKeys(on) {
  for (const id of MAP_COMMANDS) {
    const key = SHORTCUTS[id][1];
    if (!on) globalShortcut.unregister(key);
    else if (!globalShortcut.isRegistered(key)) register(id, () => { if (loaded) win.webContents.send('command', id); });
  }
}
app.on('second-instance', () => { if (win) show(true); });
if (locked) app.whenReady().then(async () => {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try { settings = sanitize(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
  catch { settings = sanitize(); }
  Menu.setApplicationMenu(null);
  const bounds = settings.bounds && onScreen(settings.bounds) ? settings.bounds : { width: 1080, height: 780 };
  win = new BrowserWindow({ ...bounds, minWidth: 300, minHeight: 200, frame: false,
    title: 'Mapino', icon: ICON, backgroundColor: '#000000', alwaysOnTop: settings.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.setOpacity(settings.opacity);
  const wc = win.webContents;
  // The map is fully local: no navigation or popups, and only clipboard writes for copied coordinates.
  const allowed = permission => permission === 'clipboard-sanitized-write';
  wc.session.setPermissionRequestHandler((_, permission, callback) => callback(allowed(permission)));
  wc.session.setPermissionCheckHandler((_, permission) => allowed(permission));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', event => event.preventDefault());
  wc.on('will-redirect', event => event.preventDefault());
  wc.on('render-process-gone', () => { loaded = false; if (win.isVisible()) loadMap(); });
  win.on('minimize', () => { unload(); bindMapKeys(false); });
  win.on('restore', () => { loadMap(); bindMapKeys(true); });
  win.on('close', () => { settings.bounds = win.getNormalBounds(); save(); });
  win.on('closed', () => app.quit());
  ipcMain.on('close', event => { if (event.sender === wc) win.close(); });
  ipcMain.on('fullscreen', event => { if (event.sender === wc) win.setFullScreen(!win.isFullScreen()); });
  // Switching maps: the page saves its choice, then the window reloads from here (page navigation is blocked).
  ipcMain.on('reload', event => { if (event.sender === wc) wc.reload(); });
  ipcMain.on('minimize', event => { if (event.sender === wc) win.minimize(); });
  ipcMain.handle('places', (event, map) => {
    if (event.sender !== wc) return false;
    if (typeof map === 'string') currentMap = map;
    return require('./locator').available(map);
  });
  ipcMain.handle('locate', async (event, request) => {
    if (event.sender !== wc) throw new Error('not allowed');
    try { return await require('./locator').locateRequest(request); }
    catch (error) { return { error: error.message }; }
  });
  // Server panel (src/server.js): set up, start and stop a DayZ server from a form. Results come back as
  // { ok } or { error } so the panel can show the message.
  const SERVER_ACTIONS = ['scan', 'save', 'start', 'stop', 'join', 'running', 'open'];
  ipcMain.handle('server', async (event, action, payload) => {
    if (event.sender !== wc || !SERVER_ACTIONS.includes(action)) return { error: 'not allowed' };
    const server = require('./server');
    server.init(path.join(app.getPath('userData'), 'servers.json'));
    try { return { ok: action === 'open' ? await shell.openPath(server.folder()) : await server[action](payload) }; }
    catch (error) { return { error: error.message }; }
  });
  const icon = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(icon);
  tray.setToolTip('Mapino');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open map', click: () => { if (clickThrough) toggleClickThrough(); show(true); } },
    { label: 'Hide map', click: hide },
    { label: 'Toggle click-through', click: toggleClickThrough },
    { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('double-click', () => { if (clickThrough) toggleClickThrough(); show(true); });
  register('toggle', () => win.isVisible() && !win.isMinimized() ? hide() : show());
  register('clickThrough', toggleClickThrough);
  register('locate', () => locateFromShortcut(false));
  register('locateMore', () => locateFromShortcut(true));
  await loadMap();
  bindMapKeys(true);
  if (smoke) {
    try {
      const assert = require('node:assert/strict');
      const js = code => wc.executeJavaScript(code);
      assert.equal(await js('!!document.getElementById("close") && !!window.desk'), true);
      const rotation = () => js('JSON.parse(localStorage.getItem("nasdara-view") || "{}").r || 0');
      const before = await rotation();
      wc.send('command', 'rotateRight');
      await new Promise(resolve => setTimeout(resolve, 300));
      const turned = ((await rotation()) - before + 2 * Math.PI) % (2 * Math.PI);
      assert.ok(Math.abs(turned - Math.PI / 12) < 1e-6, 'rotate command applied');
      wc.send('command', 'rotateLeft');
      hide(); assert.equal(loaded, !settings.unloadHidden); show(); assert.equal(loaded, true);
      toggleClickThrough(); assert.equal(clickThrough, true); toggleClickThrough();
      const bound = Object.values(SHORTCUTS).filter(([, key]) => globalShortcut.isRegistered(key)).length;
      console.log(`SMOKE PASS: map page, rotate command, hide/show, shortcuts registered: ${bound}/${Object.keys(SHORTCUTS).length}`);
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  }
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); });
app.on('window-all-closed', () => app.quit());
