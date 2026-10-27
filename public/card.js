// "My QR card": the details you may share live in the Notion database "My sharing details" (the master copy).
// This screen loads them through the Worker, lets you choose what to share right now, and turns the choice into a QR code
// holding a vCard. The QR code itself contains the contact, so scanning needs no internet and no app on the other side.
// The phone keeps the last copy it loaded, so the code still works with no signal.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']; // names with accents (Álvaro, Rütter)
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: nothing to remember */ } },
  };
  const read = (k, d) => { try { return JSON.parse(store.get(k, 'null')) ?? d; } catch { return d; } };
  const cfg = () => ({ url: (store.get('cc.url') || location.origin).replace(/\/+$/, ''), tok: store.get('cc.tok') });

  let items = read('cc.me.items', []);        // rows of "My sharing details"
  let groupsOn = read('cc.me.groups', null);  // {groupName: bool}: which groups are ticked right now
  let over = read('cc.me.over', {});          // {rowId: bool}: single details ticked or unticked by hand
  let editing = false;
  const persist = () => { store.set('cc.me.groups', JSON.stringify(groupsOn)); store.set('cc.me.over', JSON.stringify(over)); };

  const NAME = new Set(['First name', 'Last name']);
  const ci = (s) => String(s || '').toLowerCase();
  const groupNames = () => [...new Set(items.flatMap((i) => i.groups))];
  function ensureGroups() {
    const first = !groupsOn || Object.keys(groupsOn).length === 0; // first time groups are known: start with Professional ticked
    groupsOn = groupsOn || {};
    for (const g of groupNames()) if (!(g in groupsOn)) groupsOn[g] = first && ci(g) === 'professional';
  }
  const included = (i) => NAME.has(i.type) || (i.id in over ? over[i.id] : i.groups.some((g) => groupsOn[g]));

  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\;').replace(/,/g, '\\,');
  const url = (s) => (/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
  const val = (type) => items.find((i) => i.type === type && i.value)?.value || '';

  // vCard 3.0 is the version every phone's contacts app reads.
  function buildVCard() {
    const first = val('First name'), last = val('Last name');
    if (!first && !last) return '';
    const on = items.filter((i) => i.value && included(i));
    const L = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(last)};${esc(first)};;;`, `FN:${esc([first, last].filter(Boolean).join(' '))}`];

    // One ORG/TITLE per card. A second organisation (for example the club next to a day job) goes into the note.
    const companies = on.filter((i) => i.type === 'Company');
    const roleFor = (c) => on.find((i) => i.type === 'Role' && i.groups.some((g) => c.groups.includes(g)))?.value || '';
    const main = companies[0];
    if (main) {
      L.push(`ORG:${esc(main.value)}`);
      if (roleFor(main)) L.push(`TITLE:${esc(roleFor(main))}`);
    }
    const note = companies.slice(1).map((c) => [roleFor(c), c.value].filter(Boolean).join(', '));

    let n = 0;
    for (const i of on) {
      if (!['Phone', 'Email', 'Website', 'Address'].includes(i.type)) continue;
      const personal = i.groups.length > 0 && i.groups.every((g) => ci(g) === 'personal');
      // A detail from a second organisation carries that organisation's name as its label, so it does not look like a second work number.
      const org = i.groups.map((g) => companies.find((c) => c.groups.includes(g))).find(Boolean);
      const label = i.label || (org && org !== main ? org.value : '');
      const add = (prop, types, value) => {
        if (label) { const g = `item${++n}`; L.push(`${g}.${prop}${types ? ';TYPE=' + types : ''}:${value}`, `${g}.X-ABLabel:${esc(label)}`); }
        else L.push(`${prop}${types ? ';TYPE=' + types : ''}:${value}`);
      };
      if (i.type === 'Phone') add('TEL', personal ? 'CELL' : 'WORK,VOICE', esc(i.value));
      if (i.type === 'Email') add('EMAIL', personal ? 'HOME,INTERNET' : 'WORK,INTERNET', esc(i.value));
      if (i.type === 'Website') add('URL', '', url(i.value).replace(/[\r\n]/g, ''));
      if (i.type === 'Address') add('ADR', personal ? 'HOME' : 'WORK', `;;${esc(i.value)};;;;`);
    }
    if (note.length) L.push(`NOTE:${esc(note.join(' | '))}`);
    L.push('END:VCARD');
    return L.join('\r\n') + '\r\n';
  }

  function drawQR(canvas, text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const count = q.getModuleCount(), quiet = 4, scale = Math.max(4, Math.floor(1024 / (count + quiet * 2)));
    const size = (count + quiet * 2) * scale;
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, size, size);
    c.fillStyle = '#000';
    for (let r = 0; r < count; r++) for (let k = 0; k < count; k++) if (q.isDark(r, k)) c.fillRect((k + quiet) * scale, (r + quiet) * scale, scale, scale);
    return count;
  }

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const setStatus = (msg, bad) => { const s = $('meStatus'); s.textContent = msg; s.classList.toggle('bad', !!bad); };

  function renderLists() {
    // group tickboxes
    const g = $('groups'); g.replaceChildren();
    for (const name of groupNames()) {
      const lab = el('label', 'check'); lab.style.marginTop = '8px';
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!groupsOn[name];
      cb.onchange = () => {
        groupsOn[name] = cb.checked;
        for (const i of items) if (i.groups.includes(name)) delete over[i.id]; // choosing a group resets hand-picked details of that group
        persist(); render();
      };
      lab.append(cb, el('span', '', name)); g.append(lab);
    }
    // detail list
    const box = $('items'); box.replaceChildren();
    const rows = items.filter((i) => !NAME.has(i.type) || editing);
    for (const i of rows) {
      if (!editing && !i.value) continue;
      const row = el('div', 'item');
      if (editing) {
        const inp = el('input'); inp.type = 'text'; inp.value = i.value; inp.setAttribute('aria-label', i.detail);
        inp.onchange = () => saveValue(i, inp);
        const l = el('label', '', i.detail); l.style.margin = '8px 0 4px';
        row.append(l, inp);
      } else {
        const lab = el('label', 'check'); lab.style.margin = '0';
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = included(i);
        cb.onchange = () => { over[i.id] = cb.checked; persist(); render(); };
        const t = el('span'); t.append(el('span', 'muted', i.detail + ': '), document.createTextNode(i.value));
        lab.append(cb, t); row.append(lab);
      }
      box.append(row);
    }
    $('editBtn').textContent = editing ? 'Done' : 'Edit values';
    $('itemsHint').classList.toggle('hidden', editing || rows.some((r) => r.value));
  }

  function render() {
    ensureGroups();
    renderLists();
    const vcard = buildVCard();
    $('qrBox').classList.toggle('hidden', !vcard);
    $('qrNeedName').classList.toggle('hidden', !!vcard);
    $('qrActions').classList.toggle('hidden', !vcard);
    $('qrDense').classList.add('hidden');
    if (!vcard) { $('qrSummary').textContent = ''; return; }
    let modules = 0;
    try { modules = drawQR($('qrCanvas'), vcard); } catch { $('qrNeedName').textContent = 'Too much to fit in one QR code. Untick a group or some details.'; $('qrNeedName').classList.remove('hidden'); $('qrBox').classList.add('hidden'); $('qrActions').classList.add('hidden'); return; }
    const count = items.filter((i) => i.value && included(i) && !NAME.has(i.type)).length;
    $('qrSummary').textContent = `Sharing ${[val('First name'), val('Last name')].filter(Boolean).join(' ')} and ${count} detail${count === 1 ? '' : 's'}`;
    $('qrDense').classList.toggle('hidden', modules <= 85); // above about 85 modules a screen at low brightness gets hard to scan
  }

  async function api(path, init = {}) {
    const c = cfg();
    if (!c.tok) throw Object.assign(new Error('Connect the service first: open Add contact and tap ⚙.'), { setup: true });
    const res = await fetch(c.url + path, { ...init, headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('The access token was not accepted. Check it under ⚙ on Add contact.');
    if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ').');
    return data;
  }

  const ago = () => { const at = Number(store.get('cc.me.at', '0')); if (!at) return ''; const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 90 ? m + ' min ago' : new Date(at).toLocaleDateString(); };
  async function load(manual) {
    setStatus('Loading from Notion…');
    try {
      const data = await api('/me');
      items = data.items;
      store.set('cc.me.items', JSON.stringify(items)); store.set('cc.me.at', String(Date.now()));
      over = Object.fromEntries(Object.entries(over).filter(([id]) => items.some((i) => i.id === id)));
      setStatus('Loaded from Notion ' + ago());
    } catch (e) {
      const have = items.length > 0;
      setStatus(have ? (e.setup || /fetch|network|Failed/i.test(e.message) ? 'Offline: using the copy from ' + ago() + '.' : e.message + ' Using the copy from ' + ago() + '.') : e.message, !have);
    }
    render();
  }
  $('reloadMe').onclick = () => load(true);

  async function saveValue(item, inp) {
    const old = item.value;
    inp.disabled = true;
    try {
      const { item: saved } = await api('/me/update', { method: 'POST', body: JSON.stringify({ id: item.id, value: inp.value }) });
      item.value = saved.value; inp.value = saved.value;
      store.set('cc.me.items', JSON.stringify(items));
      setStatus('Saved to Notion.');
    } catch (e) { item.value = old; inp.value = old; setStatus('Not saved: ' + e.message, true); }
    inp.disabled = false;
    render();
  }
  $('editBtn').onclick = () => { editing = !editing; render(); };

  async function vcfFile() { return new File([buildVCard()], ([val('First name'), val('Last name')].join('-')).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, '-').replace(/^-|-$/g, '') + '.vcf', { type: 'text/vcard' }); }
  $('shareVcf').onclick = async () => {
    const f = await vcfFile();
    try {
      if (navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: 'My contact details' }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.append(a); a.click(); a.remove();
  };

  let wake = null;
  async function openFull(on) {
    $('qrFull').classList.toggle('hidden', !on);
    if (on) { $('qrFullImg').src = $('qrCanvas').toDataURL('image/png'); try { wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ } }
    else if (wake) { try { await wake.release(); } catch { /* already released */ } wake = null; }
  }
  $('fullBtn').onclick = () => openFull(true);
  $('qrFull').onclick = () => openFull(false);

  // Tabs
  let loadedAt = 0;
  function tab(name) {
    const qr = name === 'qr', recent = name === 'recent';
    $('addView').classList.toggle('hidden', qr || recent);
    $('qrView').classList.toggle('hidden', !qr);
    $('recentView').classList.toggle('hidden', !recent);
    $('tabAdd').setAttribute('aria-selected', String(!qr && !recent));
    $('tabQr').setAttribute('aria-selected', String(qr));
    $('tabRecent').setAttribute('aria-selected', String(recent));
    $('title').textContent = qr ? 'My QR card' : recent ? 'People' : 'Add contact';
    if (qr || recent) $('setup').classList.add('hidden');
    if (recent && window.CCRecent) CCRecent.show();
    if (qr) {
      render();
      if (Date.now() - loadedAt > 60000) { loadedAt = Date.now(); load(); } // fresh from Notion whenever you open it
    }
  }
  $('tabAdd').onclick = () => tab('add');
  $('tabQr').onclick = () => tab('qr');
  $('tabRecent').onclick = () => tab('recent');
  $('gear').addEventListener('click', () => tab('add')); // settings live on the Add screen
  // A share (?shared=1) always opens "Add"; the home-screen shortcut opens the QR card.
  const q = new URLSearchParams(location.search);
  tab(q.get('shared') ? 'add' : q.get('tab') === 'qr' ? 'qr' : q.get('tab') === 'recent' ? 'recent' : 'add');
  if (q.get('tab')) history.replaceState(null, '', location.pathname);
})();
