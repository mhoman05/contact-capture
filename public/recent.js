// The "Recent" tab: the people you added last, to follow up on. Tap a name to add details, a note or a follow-up date;
// everything is saved straight to Notion. People whose follow-up date has come are marked and counted.
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

  let people = (() => { try { return JSON.parse(store.get('cc.recent.people', '[]')); } catch { return []; } })();
  let filter = 'all', stale = true, loadedAt = 0, current = null;

  const due = (p) => !!p.next_followup && p.next_followup <= today();
  const dueCount = () => people.filter(due).length;
  function updateBadge() {
    const n = dueCount();
    $('tabRecent').textContent = n ? 'Recent (' + n + ')' : 'Recent';
    try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch { /* optional */ }
  }
  function ago(iso) {
    if (!iso) return '';
    const d = Math.floor((Date.now() - new Date(iso)) / 864e5);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? d + ' days ago' : new Date(iso).toLocaleDateString();
  }
  const setStatus = (msg, bad) => { const s = $('recStatus'); s.textContent = msg; s.classList.toggle('bad', !!bad); };

  async function api(path, init = {}) {
    const c = cfg();
    if (!c.tok) throw new Error('Connect the service first: open Add contact and tap ⚙.');
    const res = await fetch(c.url + path, { ...init, headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('The access token was not accepted. Check it under ⚙ on Add contact.');
    if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ').');
    return data;
  }

  function render() {
    const q = $('recFilter').value.trim().toLowerCase();
    let list = people.filter((p) => (filter === 'review' ? p.needs_review : filter === 'due' ? due(p) : true))
      .filter((p) => !q || [p.name, p.company, p.role, p.how, p.notes, p.events.join(' ')].join(' ').toLowerCase().includes(q));
    if (filter === 'due') list = [...list].sort((a, b) => a.next_followup.localeCompare(b.next_followup));
    document.querySelectorAll('#recChips button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === filter)));
    $('recChips').querySelector('[data-f=due]').textContent = 'Follow up' + (dueCount() ? ' (' + dueCount() + ')' : '');
    $('recChips').querySelector('[data-f=review]').textContent = 'To review' + (people.some((p) => p.needs_review) ? ' (' + people.filter((p) => p.needs_review).length + ')' : '');
    const box = $('recList'); box.replaceChildren();
    for (const p of list) {
      const b = el('button', 'person'); b.type = 'button';
      const top = el('div', 'ptop'); top.append(el('b', '', p.name), el('span', 'muted', ago(p.created)));
      b.append(top);
      const sub = [p.company, p.role].filter(Boolean).join(' · ');
      if (sub) b.append(el('div', 'muted', sub));
      const tags = el('div');
      if (due(p)) tags.append(el('span', 'tag due', 'Follow up ' + (p.next_followup < today() ? 'overdue' : 'today')));
      else if (p.next_followup) tags.append(el('span', 'tag', 'Follow up ' + p.next_followup));
      if (p.needs_review) tags.append(el('span', 'tag', 'Needs review'));
      for (const e of p.events.slice(0, 1)) tags.append(el('span', 'tag', e));
      if (tags.childNodes.length) b.append(tags);
      b.onclick = () => openSheet(p);
      box.append(b);
    }
    if (!list.length) box.append(el('div', 'muted', people.length ? 'Nobody matches.' : 'Nobody yet. People you add appear here.'));
    updateBadge();
  }

  async function load(manual) {
    setStatus('Loading from Notion…');
    try {
      people = (await api('/people/recent?limit=100')).people;
      store.set('cc.recent.people', JSON.stringify(people));
      stale = false; loadedAt = Date.now();
      setStatus('');
    } catch (e) {
      setStatus(people.length ? 'Could not reach Notion (' + e.message + '). Showing the last list.' : e.message, !people.length);
    }
    render();
  }

  // ---- one person -----------------------------------------------------------
  const FIELDS = ['name', 'company', 'role', 'phone', 'email', 'linkedin', 'telegram', 'location'];
  function openSheet(p) {
    current = p;
    for (const k of FIELDS) $('p-' + k).value = p[k] || '';
    $('p-note').value = ''; $('p-follow').value = p.next_followup || ''; $('p-review').checked = !!p.needs_review;
    $('p-notes').textContent = p.notes || 'No notes yet.';
    $('p-how').textContent = [p.how, p.events.length ? 'Events: ' + p.events.join(', ') : ''].filter(Boolean).join(' · ');
    $('p-how').classList.toggle('hidden', !$('p-how').textContent);
    $('p-msg').textContent = ''; $('p-msg').classList.remove('bad');
    const acts = $('p-actions'); acts.replaceChildren();
    const link = (label, href) => { const a = el('a', 'btn', label); a.href = href; a.target = '_blank'; a.rel = 'noopener'; acts.append(a); };
    if (p.phone) { link('📞 Call', 'tel:' + p.phone.replace(/[^\d+]/g, '')); link('💬 WhatsApp', 'https://wa.me/' + p.phone.replace(/\D/g, '')); }
    if (p.email) link('✉ Email', 'mailto:' + p.email);
    if (p.telegram) link('Telegram', p.telegram);
    if (p.linkedin) link('LinkedIn', p.linkedin);
    $('p-notion').href = p.url;
    $('personSheet').classList.remove('hidden');
    $('personSheet').scrollTop = 0;
  }
  const closeSheet = () => { $('personSheet').classList.add('hidden'); current = null; };
  $('p-close').onclick = closeSheet;

  async function save(extra) {
    if (!current) return;
    const body = { id: current.id, today: today(), ...extra };
    for (const k of FIELDS) { const v = $('p-' + k).value.trim(); if (v !== (current[k] || '')) body[k] = v; }
    const note = $('p-note').value.trim(); if (note) body.note = note;
    if ($('p-review').checked !== !!current.needs_review) body.needs_review = $('p-review').checked;
    if (!('next_followup' in body) && $('p-follow').value !== (current.next_followup || '')) body.next_followup = $('p-follow').value;
    if (Object.keys(body).length <= 2) { $('p-msg').textContent = 'Nothing changed.'; return; }
    $('p-save').disabled = true; $('p-msg').classList.remove('bad'); $('p-msg').textContent = 'Saving to Notion…';
    try {
      const { person } = await api('/people/update', { method: 'POST', body: JSON.stringify(body) });
      const i = people.findIndex((x) => x.id === person.id);
      if (i >= 0) people[i] = person; else people.unshift(person);
      store.set('cc.recent.people', JSON.stringify(people));
      render(); openSheet(person); $('p-msg').textContent = 'Saved to Notion.';
    } catch (e) { $('p-msg').classList.add('bad'); $('p-msg').textContent = 'Not saved: ' + e.message; }
    $('p-save').disabled = false;
  }
  $('p-save').onclick = () => save({});
  $('p-done').onclick = () => { $('p-follow').value = ''; if (!$('p-note').value.trim()) $('p-note').value = 'Followed up'; save({ next_followup: '' }); };
  document.querySelectorAll('[data-snooze]').forEach((b) => { b.onclick = () => { $('p-follow').value = plusDays(Number(b.dataset.snooze)); }; });

  document.querySelectorAll('#recChips button').forEach((b) => { b.onclick = () => { filter = b.dataset.f; render(); }; });
  $('recFilter').oninput = render;
  $('recReload').onclick = () => load(true);

  window.CCRecent = {
    show() { render(); if (stale || Date.now() - loadedAt > 60000) load(); },
    invalidate() { stale = true; },
    refreshBadge() { if (cfg().tok && (stale || Date.now() - loadedAt > 300000)) load(); else updateBadge(); },
  };
  updateBadge();
  if (cfg().tok) setTimeout(() => window.CCRecent.refreshBadge(), 800); // the count on the tab is right as soon as the app opens
})();
