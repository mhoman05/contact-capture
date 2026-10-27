// The "Companies" side of the People tab: your Notion Companies database on the phone. A list you can search and filter by
// relationship; tap a company for its details, the people who work there, open tasks and the meetings and interactions of the
// company and its people. Edit it, add a task or a person for it, or create a new company.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: nothing to remember */ } },
  };
  const cfg = () => ({ url: location.origin, tok: store.get('cc.tok') });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ---- the phone's copy ---------------------------------------------------------------------
  let dbp = null;
  const idb = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('cc-companies', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const kvGet = async () => { try { const d = await idb(); return await new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } };
  const kvSet = async (v) => { try { const d = await idb(); await new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, 'state'); t.oncomplete = res; t.onerror = res; }); } catch { /* storage unavailable */ } };

  let state = { items: {}, syncedAt: '', fullAt: '' };
  let stale = true, syncing = false, loadedAt = 0, current = null, creating = false, editing = false;
  const ui = { rel: 'all', sort: store.get('cc.c.sort', 'az'), limit: 100, mode: store.get('cc.p.mode', 'people') };
  const all = () => Object.values(state.items);
  const persist = () => kvSet(state);
  const people = () => (window.CCRecent && CCRecent.people ? CCRecent.people() : []);
  const personName = (id) => (people().find((p) => p.id === id) || {}).name || '…';
  const setStatus = (msg, bad) => { const s = $('compStatus'); s.textContent = msg; s.classList.toggle('bad', !!bad); };

  async function api(path, init = {}) {
    const c = cfg();
    if (!c.tok) throw new Error('Connect the service first: open Add and tap ⚙.');
    const res = await fetch(c.url + path, { ...init, headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('The access token was not accepted. Check it under ⚙ on Add.');
    if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ').');
    return data;
  }

  async function sync(full) {
    if (syncing) return;
    syncing = true;
    const started = new Date().toISOString();
    const doFull = full || !state.syncedAt || Date.now() - Date.parse(state.fullAt || 0) > 864e5;
    const items = doFull ? {} : { ...state.items };
    const since = doFull ? '' : new Date(Date.parse(state.syncedAt) - 120000).toISOString();
    let cursor = '';
    try {
      do {
        const q = new URLSearchParams(); if (cursor) q.set('cursor', cursor); if (since) q.set('since', since);
        const data = await api('/companies/list' + (q.toString() ? '?' + q : ''));
        for (const c of data.companies) items[c.id] = c;
        cursor = data.next_cursor || '';
        if (doFull) { setStatus('Loading companies… ' + Object.keys(items).length); if (!state.syncedAt) { state = { ...state, items: { ...items } }; render(); } }
      } while (cursor);
      state = { items, syncedAt: started, fullAt: doFull ? started : state.fullAt };
      await persist(); stale = false; loadedAt = Date.now(); setStatus('');
    } catch (e) { setStatus(all().length ? 'Could not reach Notion (' + e.message + '). Showing the copy on this phone.' : e.message, !all().length); }
    syncing = false; render();
  }

  // ---- the switch between People and Companies ---------------------------------------------------
  function applyMode() {
    const comp = ui.mode === 'companies';
    $('peopleBox').classList.toggle('hidden', comp); $('compBox').classList.toggle('hidden', !comp);
    $('pmode').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === ui.mode)));
    if (comp) { render(); if (!syncing && (stale || Date.now() - loadedAt > 60000)) sync(); }
  }
  $('pmode').querySelectorAll('button').forEach((b) => { b.onclick = () => { ui.mode = b.dataset.m; store.set('cc.p.mode', ui.mode); applyMode(); }; });

  // ---- the list ----------------------------------------------------------------------------------
  function visible() {
    const q = fold($('compFilter').value.trim());
    const list = all().filter((c) => ui.rel === 'all' || (ui.rel === 'none' ? !c.relationship : c.relationship === ui.rel))
      .filter((c) => !q || fold([c.name, c.industry, c.location, c.relationship, c.notes, c.why, c.website].join(' ')).includes(q));
    if (ui.sort === 'new') list.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    else list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return list;
  }
  function render() {
    if (ui.mode !== 'companies') return;
    $('compSort').value = ui.sort;
    document.querySelectorAll('#compChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === ui.rel)));
    const list = visible(), shown = list.slice(0, ui.limit);
    $('compCount').textContent = list.length === all().length ? all().length + ' companies' : list.length + ' of ' + all().length + ' companies';
    const box = $('compList'); box.replaceChildren();
    let letter = '';
    for (const c of shown) {
      if (ui.sort === 'az') { const l = fold(c.name).charAt(0).toUpperCase(); const h = /[A-Z]/.test(l) ? l : '#'; if (h !== letter) { letter = h; box.append(el('div', 'muted letter', h)); } }
      const b = el('button', 'person'); b.type = 'button';
      const top = el('div', 'ptop'); top.append(el('b', '', c.name), el('span', 'muted', c.people_ids.length ? c.people_ids.length + (c.people_ids.length === 1 ? ' person' : ' people') : ''));
      b.append(top);
      const sub = [c.industry, c.location].filter(Boolean).join(' · ');
      if (sub) b.append(el('div', 'muted', sub));
      const tags = el('div');
      if (c.relationship) tags.append(el('span', 'tag', c.relationship));
      if (c.priority) tags.append(el('span', 'tag', c.priority + ' priority'));
      if (tags.childNodes.length) b.append(tags);
      b.onclick = () => openSheet(c);
      box.append(b);
    }
    if (!list.length) box.append(el('div', 'muted', all().length ? 'No company matches.' : syncing ? 'Loading…' : 'No companies yet.'));
    $('compMore').classList.toggle('hidden', list.length <= ui.limit);
    $('compMore').textContent = 'Show ' + Math.min(100, list.length - ui.limit) + ' more';
  }
  document.querySelectorAll('#compChips button').forEach((b) => { b.onclick = () => { ui.rel = b.dataset.r; ui.limit = 100; render(); }; });
  $('compFilter').oninput = () => { ui.limit = 100; render(); };
  $('compSort').onchange = () => { ui.sort = $('compSort').value; store.set('cc.c.sort', ui.sort); render(); };
  $('compMore').onclick = () => { ui.limit += 100; render(); };
  $('compReload').onclick = () => sync(true);
  $('compNew').onclick = () => openNew();

  // ---- one company ---------------------------------------------------------------------------------
  const EF = { name: 'c-name', website: 'c-website', linkedin: 'c-linkedin', location: 'c-location', industry: 'c-industry', relationship: 'c-relationship', priority: 'c-priority', why: 'c-why', notes: 'c-notes' };
  const history = new Map();
  function line(label, value, href) {
    const row = el('div', 'kv'); row.append(el('span', 'muted', label));
    if (href) { const a = el('a', '', value); a.href = href; a.target = '_blank'; a.rel = 'noopener'; row.append(a); } else row.append(el('span', '', value));
    return row;
  }
  function showView(c) {
    $('cv-name').textContent = c.name;
    $('cv-sub').textContent = [c.industry, c.location].filter(Boolean).join(' · ');
    const tags = $('cv-tags'); tags.replaceChildren();
    if (c.relationship) tags.append(el('span', 'tag', c.relationship));
    if (c.priority) tags.append(el('span', 'tag', c.priority + ' priority'));
    const info = $('cv-info'); info.replaceChildren();
    if (c.website) info.append(line('Website', c.website.replace(/^https?:\/\/(www\.)?/, ''), c.website));
    if (c.linkedin) info.append(line('LinkedIn', c.linkedin.replace(/^https?:\/\/(www\.)?/, ''), c.linkedin));
    if (c.why) info.append(line('Why it matters', c.why));
    if (c.notes) info.append(line('Notes', c.notes));
    if (!info.childNodes.length) info.append(el('div', 'muted', 'No details yet. Tap Edit to add some.'));
    // people who work there
    const pbox = $('cv-people'); pbox.replaceChildren();
    for (const id of c.people_ids) {
      const p = people().find((x) => x.id === id);
      const row = el('div', 'kv'); row.style.cursor = 'pointer';
      row.append(el('span', 'muted', p && p.role ? p.role.slice(0, 18) : ''), el('b', '', p ? p.name : '…'));
      row.onclick = () => { if (window.CCRecent) CCRecent.openPerson(id); };
      pbox.append(row);
    }
    if (!c.people_ids.length) pbox.append(el('div', 'muted', 'Nobody linked yet.'));
    // tasks
    const tbox = $('cv-tasks'); tbox.replaceChildren();
    const tasks = window.CCTasks && CCTasks.forCompany ? CCTasks.forCompany(c.id, c.people_ids) : [];
    for (const t of tasks) {
      const row = el('div', 'kv'); row.style.cursor = 'pointer';
      row.append(el('span', 'muted', t.due || '—')); const b = el('span'); b.append(el('b', '', t.title)); if (t.person_ids.length) b.append(el('span', 'muted', ' · ' + t.person_ids.map(personName).join(', ')));
      row.append(b); row.onclick = () => { if (window.CCTasks) CCTasks.openTask(t.id); };
      tbox.append(row);
    }
    if (!tasks.length) tbox.append(el('div', 'muted', 'No open tasks for this company or its people.'));
    $('cv-notion').href = c.url;
    loadHistory(c);
  }
  async function loadHistory(c) {
    const box = $('cv-history');
    const draw = (items) => {
      box.replaceChildren();
      if (!items.length) { box.append(el('div', 'muted', 'No meetings or interactions logged yet.')); return; }
      for (const h of items) {
        const row = el('div', 'kv'); row.append(el('span', 'muted', h.date || '—'));
        const t = el('span'); t.append(el('b', '', h.title), el('span', 'muted', ' · ' + h.type));
        if (h.summary) t.append(el('div', 'muted', h.summary.length > 160 ? h.summary.slice(0, 157) + '…' : h.summary));
        row.append(t); box.append(row);
      }
    };
    if (history.has(c.id)) { draw(history.get(c.id)); return; }
    box.replaceChildren(el('div', 'muted', 'Loading…'));
    try {
      const { history: items } = await api('/companies/history?id=' + encodeURIComponent(c.id));
      history.set(c.id, items);
      if (current && current.id === c.id) draw(items);
    } catch (e) { if (current && current.id === c.id) box.replaceChildren(el('div', 'muted', 'Could not load the history (' + e.message + ').')); }
  }
  function setEditing(on) { editing = on; $('cv').classList.toggle('hidden', on); $('ce').classList.toggle('hidden', !on); }
  function fillForm(c) { for (const [k, id] of Object.entries(EF)) $(id).value = c ? c[k] || '' : ''; $('c-msg').textContent = ''; $('c-msg').classList.remove('bad'); }
  function openSheet(c, edit) {
    current = c; creating = false; fillForm(c); setEditing(!!edit); showView(c);
    $('companySheet').classList.remove('hidden'); $('companySheet').scrollTop = 0;
  }
  function openNew(name) {
    current = null; creating = true; fillForm(null); if (name) $('c-name').value = name; setEditing(true);
    $('cv-notion').href = '#';
    $('companySheet').classList.remove('hidden'); $('companySheet').scrollTop = 0; $('c-name').focus();
  }
  const closeSheet = () => { $('companySheet').classList.add('hidden'); current = null; creating = false; };
  $('c-close').onclick = () => { if (editing && current) setEditing(false); else closeSheet(); };
  $('c-edit').onclick = () => { setEditing(true); $('companySheet').scrollTop = 0; };
  $('c-cancel').onclick = () => { if (creating) closeSheet(); else openSheet(current); };
  $('c-addtask').onclick = () => { if (!current || !window.CCTasks) return; const c = current; closeSheet(); CCTasks.startAdd(null, { id: c.id, name: c.name }); };
  $('c-addperson').onclick = () => { if (!current || !window.CCAddPerson) return; const c = current; closeSheet(); CCAddPerson({ company: c.name }); };

  $('c-save').onclick = async () => {
    const body = {};
    for (const [k, id] of Object.entries(EF)) { const v = $(id).value.trim(); if (creating ? v : v !== (current[k] || '')) body[k] = v; }
    if (creating && !body.name) { $('c-msg').classList.add('bad'); $('c-msg').textContent = 'Give the company a name.'; return; }
    if (!creating && !Object.keys(body).length) { $('c-msg').classList.remove('bad'); $('c-msg').textContent = 'Nothing changed.'; return; }
    $('c-save').disabled = true; $('c-msg').classList.remove('bad'); $('c-msg').textContent = 'Saving to Notion…';
    try {
      const data = creating ? await api('/companies/create', { method: 'POST', body: JSON.stringify(body) }) : await api('/companies/update', { method: 'POST', body: JSON.stringify({ id: current.id, ...body }) });
      const c = data.company; state.items[c.id] = c; await persist(); history.delete(c.id);
      ui.mode = 'companies'; render();
      openSheet(c); if (data.existed) $('c-msg').textContent = 'A company with this name already exists. Opened it instead.';
    } catch (e) { $('c-msg').classList.add('bad'); $('c-msg').textContent = 'Not saved: ' + e.message; }
    $('c-save').disabled = false;
  };

  window.CCCompanies = {
    show() { applyMode(); },
    invalidate() { stale = true; },
    byName: (name) => { const f = fold(name).split(',')[0].trim(); return all().find((c) => fold(c.name) === f) || null; },
    openByName(name) { const c = this.byName(name); if (c) { if (window.CCTab) CCTab('recent'); ui.mode = 'companies'; store.set('cc.p.mode', 'companies'); applyMode(); openSheet(c); return true; } return false; },
    openById(id) { const c = state.items[id]; if (c) { if (window.CCTab) CCTab('recent'); ui.mode = 'companies'; store.set('cc.p.mode', 'companies'); applyMode(); openSheet(c); return true; } return false; },
  };
  kvGet().then((saved) => { if (saved && saved.items) state = saved; applyMode(); });
})();
