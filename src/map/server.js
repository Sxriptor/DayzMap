// DayZ server panel: one form that sets up a server (map, name, passwords, mods, VPP admins) and starts, stops or
// joins it. The main process does the work (src/server.js); this only fills and reads the form.
(() => {
  const desk = window.desk, $ = id => document.getElementById(id);
  if (!desk?.server) return; // only in the app
  const panel = $('server'), toggle = $('serverToggle'), form = $('srvForm');
  const STATE = { linked: 'in server', copy: 'in server', outdated: 'old copy: updates on save', missing: '' };
  const FIELDS = { hostname: 'srvHostname', template: 'srvMap', password: 'srvPassword', passwordAdmin: 'srvPasswordAdmin', maxPlayers: 'srvPlayers',
    serverTimeAcceleration: 'srvDay', serverNightTimeAcceleration: 'srvNight', port: 'srvPort', cpu: 'srvCpu', restartHours: 'srvRestart' };
  let info = null, admins = [], polling = 0;
  toggle.hidden = false;

  const status = (text, error = false) => { $('srvStatus').textContent = text; $('srvStatus').classList.toggle('error', error); };
  const log = (done = [], warnings = []) => {
    $('srvLog').replaceChildren(...done.map(t => item(t)), ...warnings.map(t => item(t, 'warn')));
  };
  const item = (text, kind) => { const li = document.createElement('li'); li.textContent = text; if (kind) li.className = kind; return li; };
  const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
  const mapName = template => (template.split('.')[1] || template).replace(/^\w/, c => c.toUpperCase());
  const vppOn = () => info.mods.some(m => m.vpp && $(`srvMod-${m.id}`)?.checked);

  // ---- Filling and reading the form ----
  function fill(values) {
    $('srvName').value = values.name || '';
    for (const [key, id] of Object.entries(FIELDS)) $(id).value = values[key] ?? '';
    $('srvThird').checked = !!values.thirdPersonView;
    $('srvCrosshair').checked = !values.disableCrosshair;
    for (const mod of info.mods) $(`srvMod-${mod.id}`).checked = (values.mods || []).includes(mod.id);
    admins = (values.admins || []).map(a => ({ ...a }));
    $('srvVppPassword').value = '';
    $('srvFileName').textContent = values.name || 'name';
    renderAdmins(); modsChanged();
  }
  function read() {
    const values = { name: $('srvName').value.trim(), thirdPersonView: $('srvThird').checked ? 1 : 0, disableCrosshair: $('srvCrosshair').checked ? 0 : 1,
      mods: info.mods.filter(m => $(`srvMod-${m.id}`).checked).map(m => m.id), admins: vppOn() ? admins : [], vppPassword: $('srvVppPassword').value };
    for (const [key, id] of Object.entries(FIELDS)) values[key] = $(id).value;
    return values;
  }

  // ---- Mods ----
  function renderMods() {
    $('srvMods').replaceChildren(...info.mods.map(mod => {
      const row = document.createElement('label'), box = document.createElement('input'), name = document.createElement('span'), state = document.createElement('em');
      box.type = 'checkbox'; box.id = `srvMod-${mod.id}`; box.addEventListener('change', modsChanged);
      name.textContent = mod.name; name.title = `${mod.name} (workshop ${mod.id}) → ${mod.folder}`;
      state.textContent = STATE[mod.state] || ''; state.className = mod.state;
      row.dataset.name = mod.name.toLowerCase(); row.append(box, name, state);
      return row;
    }));
    if (!info.mods.length) $('srvMods').textContent = 'No workshop mods downloaded. Subscribe to mods in the Steam Workshop for DayZ first.';
  }
  function modsChanged() {
    const count = info.mods.filter(m => $(`srvMod-${m.id}`)?.checked).length;
    $('srvModCount').textContent = `${count} of ${info.mods.length} on`;
    $('srvVpp').hidden = !vppOn();
  }
  $('srvModFilter').addEventListener('input', () => {
    const q = $('srvModFilter').value.trim().toLowerCase();
    for (const row of $('srvMods').children) if (row.dataset) row.hidden = !!q && !row.dataset.name.includes(q);
  });

  // ---- VPP admins: who, and super admin or a VPP user group ----
  function renderAdmins() {
    $('srvAdmins').replaceChildren(...admins.map((admin, i) => {
      const row = document.createElement('div'); row.className = 'srv-admin';
      const name = Object.assign(document.createElement('input'), { value: admin.name || '', placeholder: 'Name', maxLength: 40 });
      const id = Object.assign(document.createElement('input'), { value: admin.id || '', placeholder: 'Steam64 ID (7656119…)', pattern: '7656119[0-9]{10}', required: true, spellcheck: false });
      const role = document.createElement('select');
      role.append(option('super', 'Super admin'), ...info.groups.map(g => option(g, `Group: ${g}`)));
      role.value = admin.role || 'super';
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn small', title: 'Remove admin' });
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      name.setAttribute('aria-label', 'Admin name'); id.setAttribute('aria-label', 'Steam64 ID'); role.setAttribute('aria-label', 'VPP role');
      name.addEventListener('input', () => { admin.name = name.value; });
      id.addEventListener('input', () => { admin.id = id.value.trim(); });
      role.addEventListener('change', () => { admin.role = role.value; });
      remove.addEventListener('click', () => { admins.splice(i, 1); renderAdmins(); });
      row.append(name, id, role, remove);
      return row;
    }));
    const add = $('srvAddAccount');
    add.replaceChildren(...info.accounts.filter(a => !admins.some(b => b.id === a.id)).map(a => option(a.id, `${a.name} (${a.id})${a.recent ? ', signed in now' : ''}`)),
      option('', 'Someone else: type their Steam64 ID'));
  }
  $('srvAddAdmin').addEventListener('click', () => {
    const account = info.accounts.find(a => a.id === $('srvAddAccount').value);
    admins.push({ id: account?.id || '', name: account?.name || '', role: 'super' });
    renderAdmins();
    if (!account) $('srvAdmins').lastChild.children[1].focus();
  });

  // ---- Setups ----
  function setupList() {
    $('srvSetups').replaceChildren(...Object.keys(info.setups).map(name => option(name, `${mapName(info.setups[name].template)}: ${info.setups[name].hostname}`)));
  }
  $('srvName').addEventListener('input', () => {
    const name = $('srvName').value.trim();
    $('srvFileName').textContent = name || 'name';
    if (info.setups[name]) fill(info.setups[name]);
  });

  // ---- Talking to the main process ----
  async function call(action, payload) {
    const answer = await desk.server(action, payload);
    if (answer.error) throw new Error(answer.error);
    return answer.ok;
  }
  async function load() {
    status('Looking for the DayZ Server…');
    try { info = await call('scan'); }
    catch (error) { status(error.message, true); form.hidden = true; return; }
    form.hidden = false;
    $('srvMap').replaceChildren(...info.maps.map(m => option(m, mapName(m))));
    $('srvCpu').max = info.cores;
    renderMods(); setupList();
    let last = null;
    try { last = JSON.parse(localStorage.getItem('server-setup')); } catch {}
    fill(info.setups[last] || info.defaults);
    $('srvVppState').textContent = info.vppPasswordSet ? 'one is set' : 'not set yet';
    await refresh();
  }
  async function refresh() {
    const up = await call('running').catch(() => false);
    status(up ? 'A DayZ server is running on this PC.' : `DayZ Server found in ${info.server}. Not running.`);
    $('srvStop').disabled = !up;
  }
  async function busy(button, work) {
    const buttons = form.querySelectorAll('.srv-actions button');
    buttons.forEach(b => { b.disabled = true; });
    try { await work(); } catch (error) { log([], [error.message]); }
    buttons.forEach(b => { b.disabled = false; });
    await refresh();
  }
  async function saveSetup() {
    if (!form.reportValidity()) throw new Error('Fix the highlighted fields first.');
    const result = await call('save', read());
    try { localStorage.setItem('server-setup', JSON.stringify(result.name)); } catch {}
    const current = read();
    info = { ...info, ...(await call('scan')) };
    renderMods(); setupList(); fill({ ...current, vppPassword: '' });
    $('srvVppState').textContent = info.vppPasswordSet || current.vppPassword ? 'one is set' : 'not set yet';
    return result;
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    busy($('srvSave'), async () => { const r = await saveSetup(); log(r.done, r.warnings); });
  });
  $('srvStart').addEventListener('click', () => busy($('srvStart'), async () => {
    const r = await saveSetup();
    await call('start', r.name);
    log([...r.done, `Started ${r.name}: its console window restarts the server every ${$('srvRestart').value} h. It takes a minute or two before it shows in the server browser (LAN / Community, or Join here).`], r.warnings);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }));
  $('srvStop').addEventListener('click', () => busy($('srvStop'), async () => {
    const r = await call('stop', $('srvName').value.trim());
    log(r.stopped ? ['Server stopped.'] : [], r.stopped ? [] : ['The server is still running; close its window by hand.']);
  }));
  $('srvJoin').addEventListener('click', () => busy($('srvJoin'), async () => {
    await call('join', $('srvName').value.trim());
    log(['Opening DayZ, straight into this server with its mods.']);
  }));
  $('srvFolder').addEventListener('click', () => call('open').catch(error => log([], [error.message])));

  // ---- Opening and closing ----
  function setOpen(open) {
    panel.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
    clearInterval(polling);
    if (open) { if (!info) load(); else refresh(); polling = setInterval(() => { if (info) refresh(); }, 5000); }
  }
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  $('closeServer').addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); toggle.focus(); } });
})();
