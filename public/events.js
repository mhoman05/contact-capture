// The event you are at: pick one of your Notion events or create a new one. People you add are linked to it.
// The choice is remembered on this phone for 12 hours so a run of contacts at the same event needs no extra taps.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: nothing to remember */ } },
  };
  const cfg = () => ({ url: (store.get('cc.url') || location.origin).replace(/\/+$/, ''), tok: store.get('cc.tok') });
  const read = (k, d) => { try { return JSON.parse(store.get(k, 'null')) ?? d; } catch { return d; } };
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  let sel = read('cc.event', null);
  if (sel && Date.now() - (sel.at || 0) > 12 * 3600 * 1000) sel = null;
  let events = read('cc.events', []);

  function showSelected() { $('evName').textContent = sel ? sel.name : 'None'; $('evChange').textContent = sel ? 'Change' : 'Choose'; }
  function choose(ev) {
    sel = ev ? { id: ev.id, name: ev.name, at: Date.now() } : null;
    store.set('cc.event', JSON.stringify(sel));
    showSelected(); close();
  }
  const close = () => { $('evPicker').classList.add('hidden'); $('evNew').classList.add('hidden'); };

  // Events closest to today first: the one you are at is almost always at the top.
  const dist = (e) => (e.date ? Math.abs(new Date(e.date) - new Date(today())) : Infinity);
  function renderList() {
    const q = $('evFilter').value.trim().toLowerCase();
    const list = events.filter((e) => !q || (e.name + ' ' + e.location).toLowerCase().includes(q)).sort((a, b) => dist(a) - dist(b));
    const box = $('evList'); box.replaceChildren();
    for (const e of list.slice(0, q ? 60 : 20)) {
      const b = el('button'); b.type = 'button';
      b.append(el('b', '', e.name), el('span', 'muted', ' ' + [e.date, e.location].filter(Boolean).join(' · ')));
      if (sel && sel.id === e.id) b.style.borderColor = 'var(--accent)';
      b.onclick = () => choose(e);
      box.append(b);
    }
    if (!list.length) box.append(el('div', 'muted', events.length ? 'No event matches. Create it with “New event”.' : 'No events yet. Create one with “New event”.'));
  }

  async function api(path, init = {}) {
    const c = cfg();
    if (!c.tok) throw new Error('Connect the service first (⚙).');
    const res = await fetch(c.url + path, { ...init, headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('The access token was not accepted. Check it under ⚙.');
    if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ').');
    return data;
  }

  async function open() {
    $('evPicker').classList.remove('hidden'); $('evNew').classList.add('hidden');
    $('evFilter').value = ''; renderList(); $('evMsg').textContent = 'Loading your events from Notion…';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      events = (await api('/events')).events;
      store.set('cc.events', JSON.stringify(events));
      $('evMsg').textContent = '';
    } catch (e) {
      $('evMsg').textContent = events.length ? 'Could not reach Notion (' + e.message + '). Showing the last list.' : e.message;
    }
    renderList();
  }

  $('evChange').onclick = open;
  $('evClose').onclick = close;
  $('evNone').onclick = () => choose(null);
  $('evFilter').oninput = renderList;
  $('evNewBtn').onclick = () => {
    $('evNew').classList.toggle('hidden');
    if (!$('evNewDate').value) $('evNewDate').value = today();
    $('evNewName').value = $('evNewName').value || $('evFilter').value;
    $('evNewName').focus();
  };
  $('evCreate').onclick = async () => {
    const name = $('evNewName').value.trim();
    if (!name) { $('evMsg').textContent = 'Give the event a name.'; return; }
    $('evCreate').disabled = true; $('evMsg').textContent = 'Creating…';
    try {
      const { event } = await api('/events/create', { method: 'POST', body: JSON.stringify({ name, date: $('evNewDate').value, type: $('evNewType').value, location: $('evNewLoc').value.trim() }) });
      events = [event, ...events]; store.set('cc.events', JSON.stringify(events));
      $('evNewName').value = ''; $('evNewLoc').value = ''; $('evMsg').textContent = '';
      choose(event);
    } catch (e) { $('evMsg').textContent = 'Not created: ' + e.message; }
    $('evCreate').disabled = false;
  };

  window.CCEvent = { current: () => (sel ? sel.id : null), name: () => (sel ? sel.name : '') };
  showSelected();
})();
