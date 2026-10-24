// Steam on this PC: its library folders, the games installed in them, and the accounts that have signed in.
const fs = require('node:fs');
const path = require('node:path');

const STEAM = 'C:\\Program Files (x86)\\Steam';

function libraries() {
  const libs = [STEAM];
  try {
    const vdf = fs.readFileSync(path.join(STEAM, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch {}
  return [...new Set(libs.map(lib => path.resolve(lib).toLowerCase()))].map(lower => libs.find(lib => path.resolve(lib).toLowerCase() === lower));
}

// The folder of an installed game (steamapps/common/<folder>) that holds exe, or null.
function findGame(folder, exe) {
  return libraries().map(lib => path.join(lib, 'steamapps', 'common', folder)).find(dir => fs.existsSync(path.join(dir, exe))) || null;
}

// Workshop downloads for an app id: [{ id, dir }] across every library.
function workshopItems(appId) {
  const items = [];
  for (const lib of libraries()) {
    const root = path.join(lib, 'steamapps', 'workshop', 'content', String(appId));
    let ids = [];
    try { ids = fs.readdirSync(root); } catch {}
    for (const id of ids) if (/^\d+$/.test(id)) items.push({ id, dir: path.join(root, id) });
  }
  return items;
}

// Accounts that have signed in to Steam here: [{ id (Steam64), name, recent }], the last one used first.
function accounts() {
  let vdf = '';
  try { vdf = fs.readFileSync(path.join(STEAM, 'config', 'loginusers.vdf'), 'utf8'); } catch { return []; }
  const list = [];
  for (const m of vdf.matchAll(/"(7656\d{13})"\s*\{([^}]*)\}/g)) {
    const field = name => (new RegExp(`"${name}"\\s+"([^"]*)"`, 'i').exec(m[2]) || [])[1];
    list.push({ id: m[1], name: field('PersonaName') || field('AccountName') || m[1], recent: field('MostRecent') === '1' });
  }
  return list.sort((a, b) => b.recent - a.recent);
}

module.exports = { libraries, findGame, workshopItems, accounts };
