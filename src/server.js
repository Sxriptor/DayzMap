// DayZ server setup, behind the Server panel (src/map/server.js): finds the DayZ Server and the workshop mods the
// game has downloaded, and turns one short form into a ready server in the server's folder:
//   serverDZ-<name>.cfg   the stock config (serverDZ.cfg) with the form's values and map
//   start-<name>.bat      launches it with the mods, restarting every few hours (the usual server.bat)
//   @<Mod>                each chosen mod, linked to its workshop download so Steam updates reach the server too
//   keys\*.bikey          each mod's signing key
//   profiles\VPPAdminTools\Permissions   the admins (super admins, or members of a VPP user group) and password
// Steam's folder is writable without admin rights (Steam's default), so none of this needs elevation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const steam = require('./steam');

const DAYZ_APP = 221100, SERVER_EXE = 'DayZServer_x64.exe';
const STEAM64 = /^7656119\d{10}$/;
const VPP = mod => mod.id === '1828439124' || /^VPPAdminTools$/i.test(mod.name);
let storePath = null; // the saved forms, by setup name (servers.json in Mapino's settings folder)

function init(file) { storePath = file; }
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
function serverDir() {
  const dir = steam.findGame('DayZServer', SERVER_EXE);
  if (!dir) throw new Error('DayZ Server is not installed. In Steam, open Library, show Tools, and install "DayZ Server".');
  return dir;
}

// ---- Mods ----
const metaField = (text, key) => (new RegExp(`^\\s*${key}\\s*=\\s*"?([^";\\r\\n]*)"?\\s*;`, 'mi').exec(text || '') || [])[1];
// The server folder name for a mod: @ and its name without spaces or symbols, which break the -mod= list in a .bat.
const modFolder = name => '@' + (name.replace(/[^A-Za-z0-9_.-]+/g, '') || 'Mod');
// Load order: frameworks first (CF, then anything calling itself a framework, core or library), then by name.
function orderMods(mods) {
  const rank = m => (/^CF$/i.test(m.name) ? 0 : /framework|core\b|librar/i.test(m.name) ? 1 : 2);
  return [...mods].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
function workshopMods() {
  return steam.workshopItems(DAYZ_APP).map(({ id, dir }) => {
    const meta = readText(path.join(dir, 'meta.cpp'));
    if (meta === null) return null;
    const name = metaField(meta, 'name') || id;
    return { id, name, dir, folder: modFolder(name), timestamp: metaField(meta, 'timestamp') || '' };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
// How a mod sits in the server folder: linked (to its workshop download), copy (same version), outdated, missing.
function modState(server, mod) {
  const target = path.join(server, mod.folder);
  let stat;
  try { stat = fs.lstatSync(target); } catch { return 'missing'; }
  if (stat.isSymbolicLink()) return 'linked';
  return metaField(readText(path.join(target, 'meta.cpp')), 'timestamp') === mod.timestamp ? 'copy' : 'outdated';
}
function linkMod(server, mod) {
  const target = path.join(server, mod.folder), state = modState(server, mod);
  if (state === 'copy') return `${mod.folder}: kept the copy already there (same version)`;
  if (state === 'linked') {
    try { if (fs.realpathSync(target).toLowerCase() === fs.realpathSync(mod.dir).toLowerCase()) return null; } catch {}
    fs.unlinkSync(target);
  }
  let note = '';
  if (state === 'outdated') {
    // An old copy makes players fail the signature check; it moves aside instead of being deleted.
    const old = path.join(server, 'mapino-old-mods');
    fs.mkdirSync(old, { recursive: true });
    let aside = path.join(old, mod.folder);
    if (fs.existsSync(aside)) aside += `-${Date.now()}`;
    fs.renameSync(target, aside);
    note = ` (the old copy is in ${path.relative(server, aside)})`;
  }
  fs.symlinkSync(mod.dir, target, 'junction');
  return `${mod.folder}: linked to the workshop download${note}`;
}
// Every .bikey in a mod (keys, Keys, key, or deeper), copied into the server's keys folder.
function copyKeys(server, mod) {
  const found = [], walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
    for (const e of entries) {
      if (e.isFile() && /\.bikey$/i.test(e.name)) found.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < 3 && !/^addons$/i.test(e.name)) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(mod.dir, 0);
  const keys = path.join(server, 'keys');
  fs.mkdirSync(keys, { recursive: true });
  const copied = [];
  for (const file of found) {
    const to = path.join(keys, path.basename(file));
    if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(file).size) continue;
    fs.copyFileSync(file, to);
    copied.push(path.basename(file));
  }
  return found.length ? copied : null;
}

// ---- serverDZ.cfg ----
const CFG = { hostname: 'string', password: 'string', passwordAdmin: 'string', maxPlayers: 'number', thirdPersonView: 'number',
  disableCrosshair: 'number', serverTimeAcceleration: 'number', serverNightTimeAcceleration: 'number' };
function readCfg(text) {
  const values = {};
  for (const [key, kind] of Object.entries(CFG)) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*("([^"]*)"|[^;]*);`, 'mi').exec(text || '');
    if (m) values[key] = kind === 'number' ? Number(m[1]) : (m[2] ?? m[1].trim());
  }
  const template = /template\s*=\s*"([^"]*)"/.exec(text || '');
  if (template) values.template = template[1];
  return values;
}
// The config with values replaced in place (comments and every other setting kept); missing keys go above Missions.
function writeCfg(text, values) {
  for (const [key, value] of Object.entries(values)) {
    if (key === 'template') {
      text = /template\s*=\s*"[^"]*"/.test(text) ? text.replace(/template\s*=\s*"[^"]*"/, () => `template="${value}"`)
        : `${text.trimEnd()}\n\nclass Missions\n{\n    class DayZ\n    {\n        template="${value}";\n    };\n};\n`;
      continue;
    }
    const literal = typeof value === 'string' ? `"${value}"` : String(value);
    const line = new RegExp(`^(\\s*${key}\\s*=\\s*)("[^"]*"|[^;]*);`, 'mi');
    if (line.test(text)) text = text.replace(line, (_, lead) => `${lead}${literal};`);
    else if (/^\s*class Missions/m.test(text)) text = text.replace(/^(\s*class Missions)/m, (_, missions) => `${key} = ${literal};\n${missions}`);
    else text = `${key} = ${literal};\n${text}`;
  }
  return text;
}

// ---- start-<name>.bat ----
function batText(dir, name, form, folders) {
  const mods = folders.length ? ` "-mod=${folders.join(';')}"` : '';
  return [
    '@echo off',
    `:: ${name}: a DayZ server set up by Mapino's Server panel. Saving there again rewrites this file.`,
    `title mapino-${name} server`,
    `cd /D "${dir}"`,
    'if not exist "profiles" mkdir "profiles"',
    ':start',
    `echo (%time%) ${name} starting.`,
    `start "DayZ Server" /min ${SERVER_EXE} -config=serverDZ-${name}.cfg -port=${form.port} -profiles=profiles -BEpath=battleye${mods} -cpuCount=${form.cpu} -dologs -adminlog -netlog -freezecheck`,
    `:: Restart every ${form.restartHours} h (a fresh start keeps the server smooth), then go round again.`,
    `timeout ${Math.round(form.restartHours * 3600)}`,
    `taskkill /im ${SERVER_EXE} /F`,
    'timeout 10',
    'goto start',
    ''
  ].join('\r\n');
}

// ---- VPPAdminTools ----
const vppDir = server => path.join(server, 'profiles', 'VPPAdminTools', 'Permissions');
const CREDENTIALS_HELP = [
  '//This password will be used by all user groups including SuperAdmins each time you login in-game.',
  '//The input in this file will be hashed on first server startup, the raw password will be lost. Store it somewhere safe and NOT within your server files!',
  '//**In case of lost password**, delete the content of THIS file you are reading, write a new password (32 Characters Maximum) save file, restart DayZ Server.'
];
function readVpp(server) {
  const dir = vppDir(server);
  const supers = (readText(path.join(dir, 'SuperAdmins', 'SuperAdmins.txt')) || '').match(/7656119\d{10}/g) || [];
  const groups = readJson(path.join(dir, 'UserGroups', 'UserGroups.json'), []);
  const first = ((readText(path.join(dir, 'credentials.txt')) || '').split(/\r?\n/)[0] || '').trim();
  const admins = supers.map(id => ({ id, name: '', role: 'super' }));
  for (const group of Array.isArray(groups) ? groups : [])
    for (const member of group.m_GroupMembers || [])
      if (STEAM64.test(member.m_Steam64ID) && !admins.some(a => a.id === member.m_Steam64ID))
        admins.push({ id: member.m_Steam64ID, name: member.m_UserName || '', role: group.m_groupName });
  for (const admin of admins) {
    const named = (groups || []).flatMap(g => g.m_GroupMembers || []).find(m => m.m_Steam64ID === admin.id);
    if (named && !admin.name) admin.name = named.m_UserName || '';
  }
  return { admins, groups: (Array.isArray(groups) ? groups : []).map(g => g.m_groupName), passwordSet: !!first && !first.startsWith('//') };
}
function writeVpp(server, admins, password) {
  const dir = vppDir(server), done = [];
  fs.mkdirSync(path.join(dir, 'SuperAdmins'), { recursive: true });
  const supers = admins.filter(a => a.role === 'super');
  fs.writeFileSync(path.join(dir, 'SuperAdmins', 'SuperAdmins.txt'), supers.map(a => a.id).join('\n'));
  done.push(`VPP super admins: ${supers.length ? supers.map(a => a.name || a.id).join(', ') : 'none'}`);
  const groupsFile = path.join(dir, 'UserGroups', 'UserGroups.json'), groups = readJson(groupsFile, null);
  if (Array.isArray(groups)) {
    for (const group of groups) {
      group.m_GroupMembers = admins.filter(a => a.role === group.m_groupName)
        .map(a => ({ m_UserName: a.name || a.id, m_Steam64ID: a.id, m_SessionId: -1 }));
      if (group.m_GroupMembers.length) done.push(`VPP group ${group.m_groupName}: ${group.m_GroupMembers.map(m => m.m_UserName).join(', ')}`);
    }
    fs.writeFileSync(groupsFile, JSON.stringify(groups, null, 4));
  }
  if (password) {
    // VPP hashes the first line on the next start; a new plain password there replaces the old one.
    fs.writeFileSync(path.join(dir, 'credentials.txt'), [password, '', '', ...CREDENTIALS_HELP, ''].join('\n'));
    done.push('VPP password set (VPP scrambles it into a hash on the next start)');
  }
  return done;
}

// ---- The form ----
function missions(server) {
  try { return fs.readdirSync(path.join(server, 'mpmissions')).filter(d => fs.existsSync(path.join(server, 'mpmissions', d, 'init.c'))); } catch { return []; }
}
// What the panel starts from with nothing saved yet: the existing serverDZ.cfg, server.bat and VPP files.
function defaults(server, mods, vpp) {
  const cfg = readCfg(readText(path.join(server, 'serverDZ.cfg')) || readText(path.join(server, 'serverDZOG.cfg')) || '');
  const bat = readText(path.join(server, 'server.bat')) || '';
  const batSet = key => (new RegExp(`^set ${key}=(.*)$`, 'mi').exec(bat) || [])[1]?.replace(/"/g, '').trim();
  const modList = (batSet('modList') || '').replace(/^-mod=/, '').split(';').map(s => s.trim().toLowerCase()).filter(Boolean);
  const maps = missions(server);
  // A config still stock (hostname EXAMPLE NAME) says nothing about the map: start from Nasdara then.
  const stock = !cfg.hostname || cfg.hostname === 'EXAMPLE NAME';
  const template = !stock && maps.includes(cfg.template) ? cfg.template : maps.find(m => /nasdara/.test(m)) || maps[0] || '';
  return {
    name: (template.split('.')[1] || 'server').replace(/[^A-Za-z0-9_-]/g, ''), template,
    hostname: stock ? 'My DayZ server' : cfg.hostname,
    password: cfg.password || '', passwordAdmin: cfg.passwordAdmin || '',
    maxPlayers: cfg.maxPlayers || 60, thirdPersonView: cfg.thirdPersonView ?? 1, disableCrosshair: cfg.disableCrosshair ?? 0,
    serverTimeAcceleration: cfg.serverTimeAcceleration || 1, serverNightTimeAcceleration: cfg.serverNightTimeAcceleration || 1,
    port: Number(batSet('serverPort')) || 2302, cpu: Math.min(os.cpus().length, Number(batSet('serverCPU')) || 4), restartHours: 4,
    mods: mods.filter(m => modList.includes(m.folder.toLowerCase())).map(m => m.id),
    admins: vpp.admins, vppPassword: ''
  };
}
function scan() {
  const server = serverDir(), mods = workshopMods(), vpp = readVpp(server);
  return {
    server, client: steam.findGame('DayZ', 'DayZ_x64.exe'), cores: os.cpus().length, maps: missions(server),
    mods: mods.map(m => ({ id: m.id, name: m.name, folder: m.folder, state: modState(server, m), vpp: VPP(m) })),
    accounts: steam.accounts(), groups: vpp.groups, vppPasswordSet: vpp.passwordSet,
    setups: readJson(storePath, {}), defaults: defaults(server, mods, vpp)
  };
}
// The form, checked and tidied; throws a message for the panel on anything it cannot use.
function clean(form, { maps, mods, groups, cores }) {
  const fail = message => { throw new Error(message); };
  const text = (value, label, { max = 80, empty = false } = {}) => {
    const s = String(value ?? '').trim();
    if (!s && !empty) fail(`${label} is empty.`);
    if (s.length > max) fail(`${label} is longer than ${max} characters.`);
    if (/["\r\n;]/.test(s)) fail(`${label} can't contain quotes or semicolons.`);
    return s;
  };
  const number = (value, label, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) fail(`${label} must be between ${min} and ${max}.`);
    return n;
  };
  const name = String(form.name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) fail('Setup name: letters, numbers, - and _ only (it names the files).');
  if (!maps.includes(form.template)) fail('Pick a map.');
  const chosen = orderMods(mods.filter(m => (form.mods || []).includes(m.id)));
  const admins = [];
  for (const a of form.admins || []) {
    const id = String(a.id || '').trim();
    if (!STEAM64.test(id)) fail(`"${id}" isn't a Steam64 ID (17 digits starting 7656119).`);
    if (admins.some(b => b.id === id)) continue;
    if (a.role !== 'super' && !groups.includes(a.role)) fail(`VPP has no user group "${a.role}".`);
    admins.push({ id, name: text(a.name, 'Admin name', { max: 40, empty: true }), role: a.role });
  }
  const vppPassword = String(form.vppPassword || '');
  if (vppPassword && (vppPassword.length > 32 || vppPassword.startsWith('//') || /[\r\n]/.test(vppPassword))) fail('VPP password: up to 32 characters, not starting with //.');
  return {
    name, template: form.template, mods: chosen.map(m => m.id), admins, vppPassword,
    hostname: text(form.hostname, 'Server name'), password: text(form.password, 'Join password', { max: 32, empty: true }),
    passwordAdmin: text(form.passwordAdmin, 'Admin password', { max: 32, empty: true }),
    maxPlayers: number(form.maxPlayers, 'Max players', 1, 127), thirdPersonView: form.thirdPersonView ? 1 : 0, disableCrosshair: form.disableCrosshair ? 1 : 0,
    serverTimeAcceleration: number(form.serverTimeAcceleration, 'Day speed', 0.1, 24), serverNightTimeAcceleration: number(form.serverNightTimeAcceleration, 'Night speed', 0.1, 64),
    port: number(form.port, 'Port', 1024, 65530), cpu: number(form.cpu, 'CPU cores', 1, cores), restartHours: number(form.restartHours, 'Restart every', 1, 48)
  };
}
function save(raw) {
  const server = serverDir(), mods = workshopMods(), vpp = readVpp(server);
  const form = clean(raw, { maps: missions(server), mods, groups: vpp.groups, cores: os.cpus().length });
  const chosen = orderMods(mods.filter(m => form.mods.includes(m.id))), done = [], warnings = [];
  for (const mod of chosen) {
    const linked = linkMod(server, mod);
    if (linked) done.push(linked);
    const keys = copyKeys(server, mod);
    if (keys === null) warnings.push(`${mod.name} has no .bikey key file; players may be kicked for it unless it is server-side only.`);
    else if (keys.length) done.push(`Key${keys.length > 1 ? 's' : ''} ${keys.join(', ')} copied into keys`);
  }
  const cfgFile = path.join(server, `serverDZ-${form.name}.cfg`);
  const base = readText(cfgFile) ?? readText(path.join(server, 'serverDZ.cfg')) ?? readText(path.join(server, 'serverDZOG.cfg')) ?? '';
  const values = Object.fromEntries(Object.keys(CFG).map(key => [key, form[key]]));
  fs.writeFileSync(cfgFile, writeCfg(base, { ...values, template: form.template }));
  done.push(`Wrote serverDZ-${form.name}.cfg (${form.template.split('.')[1]}, "${form.hostname}")`);
  fs.writeFileSync(path.join(server, `start-${form.name}.bat`), batText(server, form.name, form, chosen.map(m => m.folder)));
  done.push(`Wrote start-${form.name}.bat (${chosen.length} mod${chosen.length === 1 ? '' : 's'}, restarts every ${form.restartHours} h)`);
  if (chosen.some(VPP)) {
    done.push(...writeVpp(server, form.admins, form.vppPassword));
    if (!form.admins.length) warnings.push('VPPAdminTools is on but nobody is an admin yet: add your Steam account under Admins.');
    if (!form.vppPassword && !vpp.passwordSet) warnings.push('VPPAdminTools has no password yet: set one, or nobody can open its menu in game.');
  }
  if (!fs.existsSync(path.join(server, 'battleye'))) warnings.push('The server has no battleye folder: verify the DayZ Server files in Steam.');
  const setups = readJson(storePath, {});
  setups[form.name] = { ...form, vppPassword: '' };
  if (storePath) fs.writeFileSync(storePath, JSON.stringify(setups, null, 2));
  return { done, warnings, name: form.name };
}

// ---- Running ----
const run = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout)));
async function running() { return (await run('tasklist', ['/FI', `IMAGENAME eq ${SERVER_EXE}`, '/NH'])).includes(SERVER_EXE); }
function start(name) {
  const server = serverDir(), bat = `start-${name}.bat`;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name) || !fs.existsSync(path.join(server, bat))) throw new Error('Save this setup first.');
  // detached: its own console window, which stays open (and keeps restarting the server) after Mapino closes.
  spawn('cmd.exe', ['/c', bat], { cwd: server, detached: true, stdio: 'ignore' }).unref();
  return { started: name };
}
async function stop(name) {
  if (/^[A-Za-z0-9_-]{1,32}$/.test(name)) await run('taskkill', ['/F', '/T', '/FI', `WINDOWTITLE eq mapino-${name} server*`]);
  if (await running()) await run('taskkill', ['/F', '/IM', SERVER_EXE]);
  return { stopped: !(await running()) };
}
// The game, straight into this server (on this PC) with the same mods from the game's own workshop folder.
function join(name) {
  const form = readJson(storePath, {})[name];
  if (!form) throw new Error('Save this setup first.');
  const client = steam.findGame('DayZ', 'DayZ_x64.exe');
  if (!client) throw new Error('DayZ is not installed.');
  const mods = workshopMods(), chosen = orderMods(mods.filter(m => form.mods.includes(m.id)));
  const modPath = mod => (fs.existsSync(path.join(client, '!Workshop', `@${mod.name}`)) ? `!Workshop\\@${mod.name}` : mod.dir);
  const args = ['-connect=127.0.0.1', `-port=${form.port}`];
  if (form.password) args.push(`-password=${form.password}`);
  if (chosen.length) args.push(`-mod=${chosen.map(modPath).join(';')}`);
  const exe = fs.existsSync(path.join(client, 'DayZ_BE.exe')) ? 'DayZ_BE.exe' : 'DayZ_x64.exe';
  spawn(path.join(client, exe), args, { cwd: client, detached: true, stdio: 'ignore' }).unref();
  return { joined: name };
}
function folder() { return serverDir(); }

module.exports = { init, scan, save, start, stop, join, running, folder, linkMod, copyKeys, readCfg, writeCfg, batText, modFolder, orderMods, readVpp, writeVpp, clean };
