// The "People" tab: your whole People database on the phone. A list you can search, sort and filter; tap a name for
// the details (contact info, notes, meetings and interactions), then edit, call, message, save to the phone or delete.
// The phone keeps its own copy (IndexedDB): the first open reads everything once, later opens only fetch what changed.
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
  const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

  // ---- the phone's copy of the database ------------------------------------------
  let dbp = null;
  const idb = () => dbp || (dbp = new Promise((res, rej) => { const r = indexedDB.open('cc-people', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const kvGet = async () => { try { const d = await idb(); return await new Promise((res) => { const q = d.transaction('kv').objectStore('kv').get('state'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } };
  const kvSet = async (v) => { try { const d = await idb(); await new Promise((res) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, 'state'); t.oncomplete = res; t.onerror = res; }); } catch { /* storage unavailable: the list is then re-read each time */ } };

  let state = { items: {}, syncedAt: '', fullAt: '' };
  let stale = true, syncing = false, loadedAt = 0, current = null, editing = false, pairs = null;
  const ui = { filter: 'all', sort: store.get('cc.p.sort', 'az'), tier: '', limit: 100 };
  const all = () => Object.values(state.items);
  const dismissed = (() => { try { return new Set(JSON.parse(store.get('cc.dupe.no', '[]'))); } catch { return new Set(); } })();
  const pairKey = (p) => [p.a.id, p.b.id].sort().join('|');

  const due = (p) => !!p.next_followup && p.next_followup <= today();
  function updateBadge() {
    const n = all().filter(due).length;
    $('tabRecent').textContent = n ? 'People (' + n + ')' : 'People';
    try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch { /* optional */ }
  }
  function ago(iso) {
    if (!iso) return '';
    const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : new Date(iso).toLocaleDateString();
  }
  const setStatus = (msg, bad) => { const s = $('recStatus'); s.textContent = msg; s.classList.toggle('bad', !!bad); };
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  async function api(path, init = {}) {
    const c = cfg();
    if (!c.tok) throw new Error('Connect the service first: open Add and tap ⚙.');
    const res = await fetch(c.url + path, { ...init, headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('The access token was not accepted. Check it under ⚙ on Add.');
    if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ').');
    return data;
  }
  const norm = (p) => ({ ...p, events: p.events || [], contact_type: p.contact_type || [], tier: p.tier || '', notes: p.notes || '' });
  const persist = () => kvSet(state);

  // ---- syncing ---------------------------------------------------------------------
  async function sync(full) {
    if (syncing) return;
    syncing = true;
    const started = new Date().toISOString();
    const doFull = full || !state.syncedAt || Date.now() - Date.parse(state.fullAt || 0) > 864e5; // everything again once a day, to notice people deleted in Notion
    const items = doFull ? {} : { ...state.items };
    const since = doFull ? '' : new Date(Date.parse(state.syncedAt) - 120000).toISOString();
    let cursor = '';
    try {
      do {
        const q = new URLSearchParams(); if (cursor) q.set('cursor', cursor); if (since) q.set('since', since);
        const data = await api('/people/list' + (q.toString() ? '?' + q : ''));
        for (const p of data.people) items[p.id] = norm(p);
        cursor = data.next_cursor || '';
        if (doFull) { setStatus('Loading people… ' + Object.keys(items).length); if (!state.syncedAt) { state = { ...state, items: { ...items } }; render(); } }
      } while (cursor);
      state = { items, syncedAt: started, fullAt: doFull ? started : state.fullAt };
      await persist(); stale = false; loadedAt = Date.now(); setStatus('');
    } catch (e) {
      setStatus(all().length ? 'Could not reach Notion (' + e.message + '). Showing the copy on this phone.' : e.message, !all().length);
    }
    syncing = false; render();
  }

  // ---- the list ---------------------------------------------------------------------
  function visible() {
    const q = fold($('recFilter').value.trim());
    let list = all().filter((p) => (ui.filter === 'review' ? p.needs_review : ui.filter === 'due' ? due(p) : true))
      .filter((p) => !ui.tier || (ui.tier === 'none' ? !p.tier : p.tier === ui.tier))
      .filter((p) => !q || fold([p.name, p.company, p.role, p.email, p.phone, p.how, p.notes, p.events.join(' '), p.location, p.tier].join(' ')).includes(q));
    if (ui.filter === 'due') list.sort((a, b) => a.next_followup.localeCompare(b.next_followup));
    else if (ui.sort === 'new') list.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    else list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return list;
  }

  function render() {
    const dupMode = ui.filter === 'dupes';
    $('recChips').querySelector('[data-f=dupes]').textContent = 'Duplicates' + (pairs ? ' (' + pairs.filter((p) => !dismissed.has(pairKey(p))).length + ')' : '');
    document.querySelectorAll('#recChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === ui.filter)));
    for (const id of ['recList', 'recMore', 'recFilter', 'recTools', 'recCount']) $(id).classList.toggle('hidden', dupMode);
    $('dupList').classList.toggle('hidden', !dupMode);
    $('recSort').value = ui.sort; $('recTier').value = ui.tier;
    $('recChips').querySelector('[data-f=due]').textContent = 'Follow up' + (all().filter(due).length ? ' (' + all().filter(due).length + ')' : '');
    $('recChips').querySelector('[data-f=review]').textContent = 'To review' + (all().some((p) => p.needs_review) ? ' (' + all().filter((p) => p.needs_review).length + ')' : '');
    updateBadge();
    if (dupMode) { renderDupes(); return; }

    const list = visible();
    const shown = list.slice(0, ui.limit);
    $('recCount').textContent = list.length === all().length ? all().length + ' people' : list.length + ' of ' + all().length + ' people';
    const box = $('recList'); box.replaceChildren();
    let letter = '';
    for (const p of shown) {
      if (ui.sort === 'az' && ui.filter !== 'due') {
        const l = fold(p.name).charAt(0).toUpperCase();
        const head = /[A-Z]/.test(l) ? l : '#';
        if (head !== letter) { letter = head; box.append(el('div', 'muted letter', head)); }
      }
      const b = el('button', 'person'); b.type = 'button';
      const top = el('div', 'ptop'); top.append(el('b', '', p.name), el('span', 'muted', ui.sort === 'new' || ui.filter === 'due' ? ago(p.created) : ''));
      b.append(top);
      const sub = [p.company, p.role].filter(Boolean).join(' · ');
      if (sub) b.append(el('div', 'muted', sub));
      const tags = el('div');
      if (p.tier) tags.append(el('span', 'tag', p.tier.split(' ')[0]));
      if (due(p)) tags.append(el('span', 'tag due', 'Follow up ' + (p.next_followup < today() ? 'overdue' : 'today')));
      else if (p.next_followup) tags.append(el('span', 'tag', 'Follow up ' + p.next_followup));
      if (p.needs_review) tags.append(el('span', 'tag', 'Needs review'));
      for (const e of p.events.slice(0, 1)) tags.append(el('span', 'tag', e));
      if (tags.childNodes.length) b.append(tags);
      b.onclick = () => openSheet(p);
      box.append(b);
    }
    if (!list.length) box.append(el('div', 'muted', all().length ? 'Nobody matches.' : syncing ? 'Loading…' : 'Nobody yet. People you add appear here.'));
    $('recMore').classList.toggle('hidden', list.length <= ui.limit);
    $('recMore').textContent = 'Show ' + Math.min(100, list.length - ui.limit) + ' more';
  }

  // ---- one person: details first, editing on request -----------------------------------
  const pid = (k) => (k === 'phone' ? 'p-phone-field' : 'p-' + k);
  const FIELDS = ['name', 'company', 'role', 'phone', 'email', 'linkedin', 'telegram', 'location'];
  const history = new Map();

  function line(label, value, href) {
    const row = el('div', 'kv'); row.append(el('span', 'muted', label));
    if (href) { const a = el('a', '', value); a.href = href; a.target = '_blank'; a.rel = 'noopener'; row.append(a); } else row.append(el('span', '', value));
    return row;
  }
  function showView(p) {
    $('pv-name').textContent = p.name;
    $('pv-sub').textContent = [p.company, p.role].filter(Boolean).join(' · ');
    const tags = $('pv-tags'); tags.replaceChildren();
    if (p.tier) tags.append(el('span', 'tag', p.tier));
    for (const t of p.contact_type) tags.append(el('span', 'tag', t));
    if (due(p)) tags.append(el('span', 'tag due', 'Follow up ' + (p.next_followup < today() ? 'overdue' : 'today')));
    else if (p.next_followup) tags.append(el('span', 'tag', 'Follow up ' + p.next_followup));
    if (p.needs_review) tags.append(el('span', 'tag', 'Needs review'));
    const acts = $('p-actions'); acts.replaceChildren();
    const link = (label, href) => { const a = el('a', 'btn', label); a.href = href; a.target = '_blank'; a.rel = 'noopener'; acts.append(a); };
    if (p.phone) { link('📞 Call', 'tel:' + p.phone.replace(/[^\d+]/g, '')); link('💬 WhatsApp', 'https://wa.me/' + p.phone.replace(/\D/g, '')); }
    if (p.email) link('✉ Email', 'mailto:' + p.email);
    if (p.telegram) link('Telegram', p.telegram);
    if (p.linkedin) link('LinkedIn', p.linkedin);
    const info = $('pv-info'); info.replaceChildren();
    if (p.phone) info.append(line('Phone', p.phone, 'tel:' + p.phone.replace(/[^\d+]/g, '')));
    if (p.email) info.append(line('Email', p.email, 'mailto:' + p.email));
    if (p.linkedin) info.append(line('LinkedIn', p.linkedin.replace(/^https?:\/\/(www\.)?/, ''), p.linkedin));
    if (p.telegram) info.append(line('Telegram', p.telegram.replace(/^https?:\/\//, ''), p.telegram));
    if (p.location) info.append(line('Location', p.location));
    if (p.how) info.append(line('How we met', p.how));
    if (p.events.length) info.append(line('Events', p.events.join(', ')));
    if (p.next_followup) info.append(line('Next follow-up', p.next_followup));
    if (p.created) info.append(line('Added', new Date(p.created).toLocaleDateString()));
    if (!info.childNodes.length) info.append(el('div', 'muted', 'No contact details yet. Tap Edit to add some.'));
    $('p-notes').textContent = p.notes || 'No notes yet.';
    $('p-notion').href = p.url;
    loadHistory(p);
  }
  async function loadHistory(p) {
    const box = $('pv-history');
    const draw = (items) => {
      box.replaceChildren();
      if (!items.length) { box.append(el('div', 'muted', 'No meetings or interactions logged yet.')); return; }
      for (const h of items) {
        const row = el('div', 'kv');
        row.append(el('span', 'muted', h.date || '—'));
        const t = el('span'); t.append(el('b', '', h.title), el('span', 'muted', ' · ' + h.type));
        if (h.summary) t.append(el('div', 'muted', h.summary.length > 160 ? h.summary.slice(0, 157) + '…' : h.summary));
        row.append(t); box.append(row);
      }
    };
    if (history.has(p.id)) { draw(history.get(p.id)); return; }
    box.replaceChildren(el('div', 'muted', 'Loading…'));
    try {
      const { history: items } = await api('/people/history?id=' + encodeURIComponent(p.id));
      history.set(p.id, items);
      if (current && current.id === p.id) draw(items);
    } catch (e) { if (current && current.id === p.id) box.replaceChildren(el('div', 'muted', 'Could not load the history (' + e.message + ').')); }
  }
  function openSheet(p, edit) {
    current = p; setEditing(!!edit);
    for (const k of FIELDS) $(pid(k)).value = p[k] || '';
    $('p-note').value = ''; $('p-follow').value = p.next_followup || ''; $('p-review').checked = !!p.needs_review; $('p-tier').value = p.tier || '';
    $('p-msg').textContent = ''; $('p-msg').classList.remove('bad'); $('p-vmsg').textContent = '';
    showView(p);
    $('personSheet').classList.remove('hidden'); $('personSheet').scrollTop = 0;
  }
  function setEditing(on) { editing = on; $('pv').classList.toggle('hidden', on); $('pe').classList.toggle('hidden', !on); }
  const closeSheet = () => { $('personSheet').classList.add('hidden'); current = null; };
  $('p-close').onclick = () => (editing ? setEditing(false) : closeSheet());
  $('p-edit').onclick = () => { setEditing(true); $('personSheet').scrollTop = 0; };
  $('p-cancel').onclick = () => { openSheet(current); };

  async function save(extra) {
    if (!current) return;
    const body = { id: current.id, today: today(), ...extra };
    for (const k of FIELDS) { const v = $(pid(k)).value.trim(); if (v !== (current[k] || '')) body[k] = v; }
    const note = $('p-note').value.trim(); if (note) body.note = note;
    if ($('p-tier').value !== (current.tier || '')) body.tier = $('p-tier').value;
    if ($('p-review').checked !== !!current.needs_review) body.needs_review = $('p-review').checked;
    if (!('next_followup' in body) && $('p-follow').value !== (current.next_followup || '')) body.next_followup = $('p-follow').value;
    if (Object.keys(body).length <= 2) { $('p-msg').textContent = 'Nothing changed.'; return; }
    $('p-save').disabled = true; $('p-msg').classList.remove('bad'); $('p-msg').textContent = 'Saving to Notion…';
    try {
      const { person } = await api('/people/update', { method: 'POST', body: JSON.stringify(body) });
      state.items[person.id] = norm(person); await persist();
      render(); openSheet(state.items[person.id]); $('p-vmsg').textContent = 'Saved to Notion.';
    } catch (e) { $('p-msg').classList.add('bad'); $('p-msg').textContent = 'Not saved: ' + e.message; }
    $('p-save').disabled = false;
  }
  $('p-save').onclick = () => save({});
  $('p-done').onclick = () => { $('p-follow').value = ''; if (!$('p-note').value.trim()) $('p-note').value = 'Followed up'; save({ next_followup: '' }); };
  document.querySelectorAll('[data-snooze]').forEach((b) => { b.onclick = () => { $('p-follow').value = plusDays(Number(b.dataset.snooze)); }; });
  $('p-savephone').onclick = async () => {
    if (!current) return;
    const m = await CCVcard.share([{ ...current, note: current.how || '' }]);
    if (m) $('p-vmsg').textContent = m;
  };
  $('p-delete').onclick = async () => {
    if (!current || !confirm('Delete ' + current.name + '? They (and the meeting logged for them) go to Notion\'s trash, restorable there for 30 days.')) return;
    $('p-delete').disabled = true;
    try {
      await api('/people/delete', { method: 'POST', body: JSON.stringify({ id: current.id }) });
      delete state.items[current.id]; await persist();
      if (pairs) pairs = pairs.filter((p) => p.a.id !== current.id && p.b.id !== current.id);
      closeSheet(); render(); setStatus('Deleted.');
    } catch (e) { $('p-vmsg').textContent = 'Not deleted: ' + e.message; }
    $('p-delete').disabled = false;
  };

  // ---- duplicate suggestions --------------------------------------------------------
  async function loadPairs() {
    setStatus('Looking for duplicates…');
    try { pairs = (await api('/people/duplicates')).pairs; setStatus(''); }
    catch (e) { setStatus(e.message, true); }
    render();
  }
  function who(p, suggested, onKeep) {
    const d = el('div', 'who');
    const head = el('div', 'ptop'); head.append(el('b', '', p.name), el('span', 'muted', 'added ' + ago(p.created)));
    d.append(head);
    const lines = [[p.company, p.role].filter(Boolean).join(' · '), [p.email, p.phone].filter(Boolean).join(' · '), [p.linkedin && 'LinkedIn', p.telegram && 'Telegram'].filter(Boolean).join(' · '), p.events.join(', '), p.notes ? p.notes.split('\n').pop() : ''];
    for (const l of lines) if (l) d.append(el('div', 'muted', l));
    const b = el('button', suggested ? 'primary' : '', 'Keep this one' + (suggested ? ' (suggested)' : '')); b.type = 'button'; b.style.marginTop = '6px'; b.style.minHeight = '40px'; b.style.width = '100%';
    b.onclick = onKeep; d.append(b);
    return d;
  }
  async function merge(pair, keepSide) {
    const keep = pair[keepSide], gone = pair[keepSide === 'a' ? 'b' : 'a'];
    if (!confirm('Keep "' + keep.name + '" and merge "' + gone.name + '" into it?\n\n' + gone.name + '’s details fill empty fields of ' + keep.name + ', their links and notes move over, and ' + gone.name + ' goes to Notion’s trash (restorable for 30 days).')) return;
    setStatus('Merging…');
    try {
      await api('/people/merge', { method: 'POST', body: JSON.stringify({ keep_id: keep.id, remove_id: gone.id, today: today() }) });
      pairs = pairs.filter((p) => ![p.a.id, p.b.id].includes(gone.id));
      delete state.items[gone.id]; await persist(); stale = true;
      setStatus('Merged ' + gone.name + ' into ' + keep.name + '.');
      sync(); // picks up the merged person as edited in Notion
    } catch (e) { setStatus('Not merged: ' + e.message, true); }
    render();
  }
  function renderDupes() {
    const box = $('dupList'); box.replaceChildren();
    if (!pairs) { loadPairs(); return; }
    const list = pairs.filter((p) => !dismissed.has(pairKey(p)));
    if (!list.length) box.append(el('div', 'muted', 'No duplicates found. People who look alike but have different emails are not suggested.'));
    for (const p of list) {
      const card = el('div', 'pair');
      const tags = el('div'); for (const r of p.reasons) tags.append(el('span', 'tag' + (p.strength === 'high' ? ' due' : ''), r)); card.append(tags);
      card.append(who(p.a, p.keep === 'a', () => merge(p, 'a')), who(p.b, p.keep === 'b', () => merge(p, 'b')));
      const no = el('button', 'chip', 'Different people'); no.type = 'button'; no.style.marginTop = '4px';
      no.onclick = () => { dismissed.add(pairKey(p)); store.set('cc.dupe.no', JSON.stringify([...dismissed])); render(); };
      card.append(no); box.append(card);
    }
  }

  // ---- controls ------------------------------------------------------------------------
  document.querySelectorAll('#recChips button').forEach((b) => { b.onclick = () => { ui.filter = b.dataset.f; ui.limit = 100; if (ui.filter === 'dupes') pairs = null; render(); }; });
  $('recFilter').oninput = () => { ui.limit = 100; render(); };
  $('recSort').onchange = () => { ui.sort = $('recSort').value; store.set('cc.p.sort', ui.sort); ui.limit = 100; render(); };
  $('recTier').onchange = () => { ui.tier = $('recTier').value; ui.limit = 100; render(); };
  $('recMore').onclick = () => { ui.limit += 100; render(); };
  $('recReload').onclick = () => sync(true);

  window.CCRecent = {
    show() { render(); if (!syncing && (stale || Date.now() - loadedAt > 60000)) sync(); },
    invalidate() { stale = true; },
    refreshBadge() { if (cfg().tok && !syncing && (stale || Date.now() - loadedAt > 300000)) sync(); else updateBadge(); },
  };
  kvGet().then((saved) => { if (saved && saved.items) { state = saved; } render(); if (cfg().tok) setTimeout(() => window.CCRecent.refreshBadge(), 600); });
})();
