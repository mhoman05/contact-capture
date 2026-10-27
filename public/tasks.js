// The "Tasks" tab: your Notion Task Database on the phone. Two lists (CRM tasks: linked to a person or company; My to-dos:
// not linked to anyone), plus the people you need to follow up with. Add a task in one line, complete it with one tap
// (with Undo), edit it, link it to people. Works without signal: changes are shown at once and sent when you are online.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: nothing to remember */ } },
  };
  const cfg = () => ({ url: (store.get('cc.url') || location.origin).replace(/\/+$/, ''), tok: store.get('cc.tok') });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const today = () => ymd(new Date());
  const plusDays = (n, from) => { const d = from ? new Date(from + 'T00:00:00') : new Date(); d.setDate(d.getDate() + n); return ymd(d); };
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const TYPES = ['Work', 'Personal', 'Advisory'];

  // ---- the phone's copy: tasks, and changes waiting to be sent -------------------------------
  let dbp = null;
  const idb = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('cc-tasks', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('ops', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (store_, mode, fn) => { try { const d = await idb(); return await new Promise((res) => { const t = d.transaction(store_, mode); const q = fn(t.objectStore(store_)); t.oncomplete = () => res(q && 'result' in q ? q.result : undefined); t.onerror = () => res(undefined); }); } catch { return undefined; } };
  const kvGet = () => run('kv', 'readonly', (s) => s.get('state'));
  const kvSet = (v) => run('kv', 'readwrite', (s) => s.put(v, 'state'));
  const opsAll = async () => ((await run('ops', 'readonly', (s) => s.getAll())) || []).sort((a, b) => a.at - b.at);
  const opPut = (o) => run('ops', 'readwrite', (s) => s.put(o));
  const opDel = (id) => run('ops', 'readwrite', (s) => s.delete(id));

  let state = { items: {}, syncedAt: '', fullAt: '' };
  let ops = [];
  let syncing = false, flushing = false, stale = true, loadedAt = 0, current = null;
  const ui = { list: store.get('cc.t.list', 'crm'), filter: store.get('cc.t.filter', 'due'), q: '' };
  const add = { due: '', types: new Set(), waiting: false, persons: [], companies: [] };
  const all = () => Object.values(state.items);
  const persist = () => kvSet(state);

  const people = () => (window.CCRecent && CCRecent.people ? CCRecent.people() : []);
  const personName = (id) => (people().find((p) => p.id === id) || {}).name || '…';
  const isOpen = (t) => t.status === 'Not started' || t.status === 'In progress';
  const isCrm = (t) => t.person_ids.length > 0 || t.company_ids.length > 0;
  const dueNow = (t) => isOpen(t) && t.due && t.due <= today();
  const peopleDue = () => people().filter((p) => p.next_followup && p.next_followup <= today());

  function updateBadge() {
    const n = all().filter(dueNow).length;
    $('tabTasks').textContent = n ? 'Tasks (' + n + ')' : 'Tasks';
    if (window.CCBadge) CCBadge.set('tasks', n);
  }
  function setStatus(msg, bad) { const s = $('tkStatus'); s.textContent = msg; s.classList.toggle('bad', !!bad); }
  let toastTimer = 0;
  function toast(msg, actionLabel, action) {
    const t = $('toast'); t.replaceChildren(el('span', '', msg));
    if (actionLabel) { const b = el('button', '', actionLabel); b.type = 'button'; b.onclick = () => { t.classList.add('hidden'); action(); }; t.append(b); }
    t.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 7000);
  }

  async function api(path, init = {}) {
    const c = cfg();
    if (!c.tok) throw Object.assign(new Error('Connect the service first: open Add and tap ⚙.'), { setup: true });
    const res = await fetch(c.url + path, { ...init, headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw Object.assign(new Error('The access token was not accepted. Check it under ⚙ on Add.'), { status: 401 });
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong (' + res.status + ').'), { status: res.status });
    return data;
  }
  const retryable = (e) => !e.status || e.status === 429 || e.status >= 500; // no connection, or a hiccup: try again later

  // ---- changes: shown at once, sent in order ---------------------------------------------------
  const temp = () => 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const blank = () => ({ id: '', url: '', title: '', status: 'Not started', due: '', completed: '', types: [], tags: [], waiting: false, person_ids: [], company_ids: [], companies: [], notes: '', next_step: '', created: new Date().toISOString(), edited: new Date().toISOString() });

  async function queue(op) { ops.push(op); await opPut(op); }

  async function createTask(fields) {
    const id = temp();
    state.items[id] = { ...blank(), id, ...fields };
    await persist();
    await queue({ id: 'op-' + id, at: Date.now(), kind: 'create', tempId: id, body: { ...fields, today: today() } });
    render(); flush();
    return id;
  }
  async function changeTask(id, patch) {
    const t = state.items[id]; if (!t) return;
    const prevStatus = t.status;
    Object.assign(t, patch);
    if (patch.status === 'Done') t.completed = today(); else if (patch.status) t.completed = '';
    t.edited = new Date().toISOString();
    await persist();
    const pending = ops.find((o) => o.kind === 'create' && o.tempId === id);
    if (pending) { Object.assign(pending.body, patch); await opPut(pending); } // not created yet: the create carries the change
    else await queue({ id: 'op-' + Date.now() + Math.random().toString(36).slice(2, 5), at: Date.now(), kind: 'update', body: { id, ...patch, today: today() } });
    render(); flush();
    return prevStatus;
  }
  async function removeTask(id) {
    delete state.items[id]; await persist();
    const pending = ops.find((o) => o.kind === 'create' && o.tempId === id);
    if (pending) { ops = ops.filter((o) => o !== pending); await opDel(pending.id); }
    else await queue({ id: 'op-' + Date.now(), at: Date.now(), kind: 'delete', body: { id } });
    render(); flush();
  }

  async function flush() {
    if (flushing || !cfg().tok) return;
    flushing = true;
    try {
      while (ops.length) {
        const op = ops[0];
        try {
          if (op.kind === 'create') {
            const { task } = await api('/tasks/create', { method: 'POST', body: JSON.stringify(op.body) });
            delete state.items[op.tempId]; state.items[task.id] = task;
          } else if (op.kind === 'update') {
            const { task } = await api('/tasks/update', { method: 'POST', body: JSON.stringify(op.body) });
            if (state.items[task.id]) state.items[task.id] = task;
          } else await api('/tasks/delete', { method: 'POST', body: JSON.stringify(op.body) });
          ops.shift(); await opDel(op.id); await persist(); render();
        } catch (e) {
          if (retryable(e)) { setStatus(ops.length + ' change' + (ops.length === 1 ? '' : 's') + ' waiting to be sent (no connection).'); break; }
          ops.shift(); await opDel(op.id);
          if (op.kind === 'create') delete state.items[op.tempId];
          toast('Not saved: ' + e.message); stale = true; // the server said no: show what Notion really has
          await persist(); render();
        }
      }
      if (!ops.length && $('tkStatus').textContent.includes('waiting to be sent')) setStatus('');
    } finally { flushing = false; }
  }

  // ---- reading from Notion -----------------------------------------------------------------------
  async function sync(full) {
    if (syncing) return;
    syncing = true;
    const started = new Date().toISOString();
    try {
      await flush();
      if (ops.length) { syncing = false; render(); return; } // offline with changes waiting: do not overwrite them
      const doFull = full || !state.syncedAt || Date.now() - Date.parse(state.fullAt || 0) > 864e5;
      const items = doFull ? {} : { ...state.items };
      const since = doFull ? '' : new Date(Date.parse(state.syncedAt) - 120000).toISOString();
      let cursor = '';
      do {
        const q = new URLSearchParams(); if (cursor) q.set('cursor', cursor); if (since) q.set('since', since);
        const data = await api('/tasks/list' + (q.toString() ? '?' + q : ''));
        for (const t of data.tasks) items[t.id] = t;
        cursor = data.next_cursor || '';
        if (doFull) { setStatus('Loading tasks… ' + Object.keys(items).length); if (!state.syncedAt) { state = { ...state, items: { ...items } }; render(); } }
      } while (cursor);
      state = { items, syncedAt: started, fullAt: doFull ? started : state.fullAt };
      await persist(); stale = false; loadedAt = Date.now(); setStatus('');
    } catch (e) {
      setStatus(all().length ? 'Could not reach Notion (' + e.message + '). Showing the copy on this phone.' : e.message, !all().length);
    }
    syncing = false; render();
  }

  // ---- the lists ---------------------------------------------------------------------------------
  const FILTERS = [['due', 'Today & overdue'], ['week', 'This week'], ['open', 'All open'], ['waiting', 'Waiting on'], ['backlog', 'Backlog'], ['done', 'Done']];
  function dueLabel(t) {
    if (!t.due) return '';
    const diff = Math.round((new Date(t.due + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 864e5);
    if (diff < 0) return 'Overdue · ' + (diff === -1 ? 'yesterday' : -diff + ' days');
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return new Date(t.due + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function visibleTasks() {
    const q = fold(ui.q.trim());
    const crm = ui.list === 'crm';
    let list = all().filter((t) => isCrm(t) === crm);
    const wk = plusDays(7);
    list = list.filter((t) => {
      switch (ui.filter) {
        case 'due': return isOpen(t) && t.due && t.due <= today();
        case 'week': return isOpen(t) && t.due && t.due <= wk;
        case 'open': return isOpen(t);
        case 'waiting': return t.waiting && t.status !== 'Done';
        case 'backlog': return t.status === 'Backlog';
        default: return t.status === 'Done';
      }
    }).filter((t) => !q || fold([t.title, t.notes, t.next_step, t.types.join(' '), t.tags.join(' '), t.companies.join(' '), t.person_ids.map(personName).join(' ')].join(' ')).includes(q));
    if (ui.filter === 'done') list.sort((a, b) => (b.completed || '').localeCompare(a.completed || '') || b.edited.localeCompare(a.edited));
    else list.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || b.created.localeCompare(a.created));
    return list;
  }
  const countFor = (crm) => all().filter((t) => isCrm(t) === crm && isOpen(t)).length;

  function render() {
    updateBadge();
    const follow = ui.list === 'follow';
    $('tkSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.l === ui.list)));
    $('tkSeg').querySelector('[data-l=crm]').textContent = 'CRM tasks (' + countFor(true) + ')';
    $('tkSeg').querySelector('[data-l=todo]').textContent = 'My to-dos (' + countFor(false) + ')';
    $('tkSeg').querySelector('[data-l=follow]').textContent = 'Follow up (' + peopleDue().length + ')';
    $('tkFilters').classList.toggle('hidden', follow);
    $('tkFilters').replaceChildren(...FILTERS.map(([k, label]) => { const b = el('button', 'chip', label); b.type = 'button'; b.setAttribute('aria-pressed', String(ui.filter === k)); b.onclick = () => { ui.filter = k; store.set('cc.t.filter', k); render(); }; return b; }));
    $('tkPersonHint').classList.toggle('hidden', ui.list !== 'crm' || add.persons.length > 0 || add.companies.length > 0);
    const box = $('tkList'); box.replaceChildren();
    if (follow) { renderFollow(box); return; }
    const list = visibleTasks();
    for (const t of list) box.append(row(t));
    if (!list.length) box.append(el('div', 'muted', all().length ? 'Nothing here.' : syncing ? 'Loading…' : 'No tasks yet. Add one above.'));
  }

  function row(t) {
    const r = el('div', 'task' + (t.status === 'Done' ? ' done' : ''));
    const c = el('button', 'tick', t.status === 'Done' ? '✓' : ''); c.type = 'button'; c.setAttribute('aria-label', t.status === 'Done' ? 'Mark not done' : 'Mark done');
    c.onclick = (e) => { e.stopPropagation(); complete(t); };
    const body = el('div', 'tbody'); body.append(el('div', 'ttitle', t.title));
    const who = [...t.person_ids.map(personName), ...t.companies].join(', ');
    const sub = [dueLabel(t), who].filter(Boolean).join(' · ');
    if (sub) body.append(el('div', 'muted' + (t.due && t.due < today() && isOpen(t) ? ' late' : ''), sub));
    const tags = el('div');
    if (t.waiting) tags.append(el('span', 'tag', 'Waiting on'));
    if (t.status === 'In progress') tags.append(el('span', 'tag', 'In progress'));
    if (t.status === 'Backlog') tags.append(el('span', 'tag', 'Backlog'));
    for (const x of [...t.types, ...t.tags].slice(0, 3)) tags.append(el('span', 'tag', x));
    if (tags.childNodes.length) body.append(tags);
    r.append(c, body); r.onclick = () => openSheet(t);
    return r;
  }

  async function complete(t) {
    if (t.status === 'Done') { await changeTask(t.id, { status: 'Not started' }); return; }
    const prev = t.status;
    await changeTask(t.id, { status: 'Done' });
    toast('Done: ' + (t.title.length > 40 ? t.title.slice(0, 37) + '…' : t.title), 'Undo', () => changeTask(t.id, { status: prev }));
  }

  function renderFollow(box) {
    const list = [...peopleDue()].sort((a, b) => a.next_followup.localeCompare(b.next_followup));
    $('tkPersonHint').classList.add('hidden');
    for (const p of list) {
      const r = el('div', 'task'); const body = el('div', 'tbody');
      body.append(el('div', 'ttitle', p.name));
      body.append(el('div', 'muted late', [(p.next_followup < today() ? 'Overdue since ' : 'Due ') + p.next_followup, p.company, p.role].filter(Boolean).join(' · ')));
      r.append(body); r.onclick = () => { if (window.CCRecent) CCRecent.openPerson(p.id); };
      box.append(r);
    }
    if (!list.length) box.append(el('div', 'muted', 'Nobody to follow up with right now. Follow-up dates are set when you add people and in each person’s details.'));
  }

  // ---- adding -----------------------------------------------------------------------------------
  function renderAddOptions() {
    $('tkDue').querySelectorAll('button[data-d]').forEach((b) => {
      const v = b.dataset.d === 'today' ? today() : b.dataset.d === 'tomorrow' ? plusDays(1) : b.dataset.d === 'week' ? plusDays(7) : '';
      b.setAttribute('aria-pressed', String(!!v && add.due === v));
    });
    $('tkDueDate').value = add.due; $('tkDueText').textContent = add.due ? 'Due ' + add.due : '';
    $('tkTypes').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(add.types.has(b.dataset.t))));
    $('tkWaiting').checked = add.waiting;
    const chips = $('tkPersonChips'); chips.replaceChildren();
    for (const p of add.persons) { const c = el('button', 'chip', p.name + ' ×'); c.type = 'button'; c.onclick = () => { add.persons = add.persons.filter((x) => x.id !== p.id); renderAddOptions(); render(); }; chips.append(c); }
    for (const co of add.companies) { const c = el('button', 'chip', co.name + ' (company) ×'); c.type = 'button'; c.onclick = () => { add.companies = add.companies.filter((x) => x.id !== co.id); renderAddOptions(); render(); }; chips.append(c); }
    $('tkPersonHint').classList.toggle('hidden', ui.list !== 'crm' || add.persons.length > 0 || add.companies.length > 0);
  }
  function personResults(q) {
    const box = $('tkPersonResults'); box.replaceChildren();
    const f = fold(q.trim()); if (!f) return;
    const hits = people().filter((p) => !add.persons.some((x) => x.id === p.id) && fold(p.name + ' ' + p.company).includes(f)).slice(0, 6);
    for (const p of hits) { const b = el('button', '', p.name + (p.company ? ' · ' + p.company : '')); b.type = 'button'; b.onclick = () => { add.persons.push({ id: p.id, name: p.name }); $('tkPersonSearch').value = ''; box.replaceChildren(); renderAddOptions(); render(); }; box.append(b); }
    if (!hits.length) box.append(el('div', 'muted', 'Nobody found. People you add appear after the People tab has loaded.'));
  }
  async function submitAdd() {
    const title = $('tkTitle').value.trim();
    if (!title) { $('tkTitle').focus(); return; }
    const fields = { title, due: add.due, types: [...add.types], waiting: add.waiting, person_ids: add.persons.map((p) => p.id) };
    if (!fields.due) delete fields.due;
    if (!fields.types.length) delete fields.types;
    if (!fields.person_ids.length) delete fields.person_ids;
    if (add.companies.length) fields.company_ids = add.companies.map((c) => c.id);
    await createTask(fields);
    $('tkTitle').value = ''; add.due = ''; add.types = new Set(); add.waiting = false; add.persons = []; add.companies = [];
    renderAddOptions(); $('tkTitle').focus();
  }
  $('tkAddBtn').onclick = submitAdd;
  $('tkTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAdd(); } });
  $('tkDue').querySelectorAll('button[data-d]').forEach((b) => { b.onclick = () => { const v = b.dataset.d === 'today' ? today() : b.dataset.d === 'tomorrow' ? plusDays(1) : plusDays(7); add.due = add.due === v ? '' : v; renderAddOptions(); }; });
  $('tkDueDate').onchange = () => { add.due = $('tkDueDate').value; renderAddOptions(); };
  $('tkTypes').querySelectorAll('button').forEach((b) => { b.onclick = () => { add.types.has(b.dataset.t) ? add.types.delete(b.dataset.t) : add.types.add(b.dataset.t); renderAddOptions(); }; });
  $('tkWaiting').onchange = () => { add.waiting = $('tkWaiting').checked; };
  $('tkPersonSearch').oninput = () => personResults($('tkPersonSearch').value);
  $('tkSeg').querySelectorAll('button').forEach((b) => { b.onclick = () => { ui.list = b.dataset.l; store.set('cc.t.list', ui.list); render(); }; });
  $('tkSearch').oninput = () => { ui.q = $('tkSearch').value; render(); };
  $('tkReload').onclick = () => sync(true);

  // ---- one task ---------------------------------------------------------------------------------
  const sheet = { persons: [], types: new Set(), tags: new Set() };
  function knownTags() { return [...new Set([...all().flatMap((t) => t.tags), ...sheet.tags])].sort(); }
  function renderSheetChips() {
    const mk = (box, items, selected, onToggle) => { box.replaceChildren(); for (const it of items) { const b = el('button', 'chip', it); b.type = 'button'; b.setAttribute('aria-pressed', String(selected.has(it))); b.onclick = () => { onToggle(it); renderSheetChips(); }; box.append(b); } };
    mk($('ts-types'), TYPES, sheet.types, (x) => (sheet.types.has(x) ? sheet.types.delete(x) : sheet.types.add(x)));
    mk($('ts-tags'), knownTags(), sheet.tags, (x) => (sheet.tags.has(x) ? sheet.tags.delete(x) : sheet.tags.add(x)));
    const pc = $('ts-persons'); pc.replaceChildren();
    for (const id of sheet.persons) {
      const c = el('span', 'chip'); const n = el('a', '', personName(id)); n.href = '#'; n.onclick = (e) => { e.preventDefault(); if (window.CCRecent) CCRecent.openPerson(id); };
      const x = el('button', '', '×'); x.type = 'button'; x.style.minHeight = '0'; x.style.padding = '0 4px'; x.style.border = '0'; x.onclick = () => { sheet.persons = sheet.persons.filter((p) => p !== id); renderSheetChips(); };
      c.append(n, x); pc.append(c);
    }
  }
  function openSheet(t) {
    current = t;
    $('ts-title').value = t.title; $('ts-status').value = t.status; $('ts-due').value = t.due; $('ts-waiting').checked = t.waiting;
    $('ts-notes').value = t.notes; $('ts-next').value = t.next_step; $('ts-person-search').value = ''; $('ts-person-results').replaceChildren();
    sheet.persons = [...t.person_ids]; sheet.types = new Set(t.types); sheet.tags = new Set(t.tags);
    $('ts-companies').textContent = t.companies.length ? 'Company: ' + t.companies.join(', ') : '';
    $('ts-notion').href = t.url || '#'; $('ts-notion').classList.toggle('hidden', !t.url);
    $('ts-msg').textContent = ''; renderSheetChips();
    $('taskSheet').classList.remove('hidden'); $('taskSheet').scrollTop = 0;
  }
  const closeSheet = () => { $('taskSheet').classList.add('hidden'); current = null; };
  $('ts-close').onclick = closeSheet;
  $('ts-person-search').oninput = () => {
    const box = $('ts-person-results'); box.replaceChildren();
    const f = fold($('ts-person-search').value.trim()); if (!f) return;
    for (const p of people().filter((p) => !sheet.persons.includes(p.id) && fold(p.name + ' ' + p.company).includes(f)).slice(0, 6)) {
      const b = el('button', '', p.name + (p.company ? ' · ' + p.company : '')); b.type = 'button';
      b.onclick = () => { sheet.persons.push(p.id); $('ts-person-search').value = ''; box.replaceChildren(); renderSheetChips(); }; box.append(b);
    }
  };
  document.querySelectorAll('[data-tsdue]').forEach((b) => { b.onclick = () => { const v = b.dataset.tsdue; $('ts-due').value = v === 'none' ? '' : v === 'today' ? today() : plusDays(Number(v), $('ts-due').value && $('ts-due').value > today() ? $('ts-due').value : today()); }; });
  $('ts-save').onclick = async () => {
    if (!current) return;
    const t = current, patch = {};
    const title = $('ts-title').value.trim(); if (!title) { $('ts-msg').textContent = 'The title cannot be empty.'; return; }
    if (title !== t.title) patch.title = title;
    if ($('ts-status').value !== t.status) patch.status = $('ts-status').value;
    if ($('ts-due').value !== t.due) patch.due = $('ts-due').value;
    if ($('ts-waiting').checked !== t.waiting) patch.waiting = $('ts-waiting').checked;
    if ($('ts-notes').value.trim() !== t.notes) patch.notes = $('ts-notes').value.trim();
    if ($('ts-next').value.trim() !== t.next_step) patch.next_step = $('ts-next').value.trim();
    const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
    if (!same([...sheet.types], t.types)) patch.types = [...sheet.types];
    if (!same([...sheet.tags], t.tags)) patch.tags = [...sheet.tags];
    if (!same(sheet.persons, t.person_ids)) patch.person_ids = [...sheet.persons];
    if (!Object.keys(patch).length) { $('ts-msg').textContent = 'Nothing changed.'; return; }
    closeSheet(); await changeTask(t.id, patch);
  };
  $('ts-done').onclick = async () => { if (!current) return; const t = current; closeSheet(); await complete(t); };
  $('ts-delete').onclick = async () => { if (!current || !confirm('Delete this task? It goes to Notion’s trash, restorable there for 30 days.')) return; const t = current; closeSheet(); await removeTask(t.id); toast('Deleted.'); };

  // ---- connection check (Settings) ---------------------------------------------------------------
  $('chk').onclick = async () => {
    const out = $('chkOut'); out.replaceChildren(el('div', 'muted', 'Checking…'));
    try {
      const { databases, connection, visible } = await api('/status');
      out.replaceChildren();
      const name = connection && connection.name ? '“' + connection.name + '”' : 'the app’s connection';
      out.append(el('p', 'muted', connection ? 'The app uses the Notion connection ' + name + (connection.workspace ? ' (workspace ' + connection.workspace + ')' : '') + '.' : 'Could not read which Notion connection the app uses.'));
      for (const d of databases) {
        const r = el('div', d.ok ? 'muted' : 'err'); r.style.margin = '4px 0';
        r.textContent = (d.ok ? '✓ ' : '✗ ') + d.name + (d.ok ? (d.title ? ' (' + d.title + ')' : '') : ': ' + d.error);
        out.append(r);
      }
      if (databases.some((d) => !d.ok)) {
        out.append(el('p', 'muted', 'To fix a ✗: in Notion open that database (or its parent page), tap the ••• menu, choose Connections and add exactly ' + name + '. A different connection (for example Claude’s) does not help the app. Then check again.'));
      }
      const det = el('details'); det.append(el('summary', 'muted', 'Databases this connection can see (' + (visible || []).length + ')'));
      for (const v of visible || []) det.append(el('div', 'muted', '• ' + v.title + '  (' + v.id.replace(/-/g, '').slice(0, 8) + '…)'));
      if (!(visible || []).length) det.append(el('div', 'muted', 'None. The connection has not been added to any page yet.'));
      out.append(det);
    } catch (e) { out.replaceChildren(el('div', 'err', e.message)); }
  };

  // ---- hooks for the other tabs --------------------------------------------------------------------
  window.CCTasks = {
    show() { render(); if (!syncing && (stale || Date.now() - loadedAt > 60000)) sync(); },
    forPerson: (id) => all().filter((t) => t.person_ids.includes(id) && (isOpen(t) || t.status === 'Backlog')).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')),
    openTask: (id) => { if (state.items[id]) openSheet(state.items[id]); },
    forCompany: (id, personIds) => all().filter((t) => (t.company_ids.includes(id) || t.person_ids.some((p) => (personIds || []).includes(p))) && (isOpen(t) || t.status === 'Backlog')).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')),
    startAdd(person, company) {
      if (window.CCTab) CCTab('tasks');
      ui.list = 'crm'; if (person && !add.persons.some((p) => p.id === person.id)) add.persons.push({ id: person.id, name: person.name });
      if (company && !add.companies.some((c) => c.id === company.id)) add.companies.push({ id: company.id, name: company.name });
      renderAddOptions(); render(); setTimeout(() => $('tkTitle').focus(), 50);
    },
    refreshBadge() { if (cfg().tok && !syncing && (stale || Date.now() - loadedAt > 300000)) sync(); else updateBadge(); },
    change: () => render(),
  };
  window.addEventListener('online', () => { flush().then(() => { if (!ops.length) sync(); }); });
  setInterval(() => { if (navigator.onLine !== false && ops.length) flush(); }, 45000);

  (async () => {
    const saved = await kvGet(); if (saved && saved.items) state = saved;
    ops = await opsAll();
    renderAddOptions(); render();
    if (cfg().tok) setTimeout(() => window.CCTasks.refreshBadge(), 900);
  })();
})();
