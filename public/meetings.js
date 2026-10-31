// "Next meetings" on the Add screen, and the briefing for one meeting: who you are meeting (their history summary, last contact,
// last interaction, open tasks) and a place for notes afterwards. Meetings come from the Notion Meetings database; the people are
// the ones linked as Attendees, read from the phone's own copy of People.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
  };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const tok = () => store.get('cc.tok');

  const KEY = 'cc.meetings';
  let meetings = [], fetchedAt = 0, current = null;
  try { const c = JSON.parse(store.get(KEY, 'null')); if (c && Array.isArray(c.meetings)) { meetings = c.meetings; fetchedAt = c.at || 0; } } catch { /* no copy yet */ }

  const startOf = (m) => { if (!m.start) return null; if (m.all_day) { const [y, mo, d] = m.start.split('-').map(Number); return new Date(y, mo - 1, d); } return new Date(m.start); };
  const endOf = (m) => { const s = startOf(m); if (!s) return null; if (m.end) return m.all_day ? new Date(startOf({ ...m, start: m.end }).getTime() + 864e5) : new Date(m.end); return new Date(s.getTime() + (m.all_day ? 864e5 : 3600e3)); };
  function when(m) {
    const s = startOf(m); if (!s) return '';
    const n = new Date();
    const days = Math.round((new Date(s.getFullYear(), s.getMonth(), s.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 864e5);
    const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days === -1 ? 'Yesterday' : s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return m.all_day ? day + ' · all day' : day + ' ' + s.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  /** Meetings that have not ended (half an hour of grace), soonest first. */
  const upcoming = () => meetings.filter((m) => { const e = endOf(m); return e && e.getTime() > Date.now() - 30 * 60000; }).sort((a, b) => startOf(a) - startOf(b));
  const person = (id) => (window.CCRecent && CCRecent.get ? CCRecent.get(id) : null);
  const company = (id) => (window.CCCompanies && CCCompanies.all ? CCCompanies.all().find((c) => c.id === id) : null);
  const locked = () => !!(window.CCLock && !CCLock.isOpen());
  let showAll = false;

  function render() {
    const card = $('meetCard'); if (!card) return;
    const list = upcoming();
    card.classList.toggle('hidden', !list.length);
    if (!list.length) return;
    const box = $('meetList'); box.replaceChildren();
    if (locked()) {
      const b = el('button', '', '🔒 Unlock to see who you are meeting'); b.type = 'button'; b.style.width = '100%';
      b.onclick = async () => { if (await CCLock.unlock()) render(); };
      box.append(b); return;
    }
    for (const m of (showAll ? list : list.slice(0, 3))) {
      const row = el('button', 'person'); row.type = 'button'; row.style.cssText = 'width:100%;text-align:left;display:block;margin-top:6px';
      const top = el('div', 'ptop'); top.append(el('b', '', m.title), el('span', 'muted', when(m)));
      row.append(top);
      const people = m.attendee_ids.map(person).filter(Boolean);
      const orgs = m.company_ids.map(company).filter(Boolean);
      const who = people.length ? people.slice(0, 2).map((p) => p.name).join(', ') + (m.attendee_ids.length > Math.min(2, people.length) ? ' +' + (m.attendee_ids.length - Math.min(2, people.length)) : '') : orgs.length ? orgs.map((c) => c.name).join(', ') : m.attendee_ids.length ? m.attendee_ids.length + ' attendee' + (m.attendee_ids.length === 1 ? '' : 's') : 'No attendees linked yet';
      row.append(el('div', 'muted', who));
      row.onclick = () => openBriefing(m);
      box.append(row);
    }
    if (list.length > 3) { const more = el('button', 'chip', showAll ? 'Show fewer' : 'Show all ' + list.length); more.type = 'button'; more.style.marginTop = '8px'; more.onclick = () => { showAll = !showAll; render(); }; box.append(more); }
    $('meetMsg').textContent = '';
  }

  async function refresh() {
    if (!tok()) return;
    const day = (n) => ymd(new Date(Date.now() + n * 864e5));
    try {
      const res = await fetch(location.origin + '/meetings/upcoming?from=' + day(-1) + '&to=' + day(8), { headers: { Authorization: 'Bearer ' + tok() }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return; // 503 when no Meetings database is set up: no card
      const data = await res.json();
      meetings = data.meetings || []; fetchedAt = Date.now();
      store.set(KEY, JSON.stringify({ at: fetchedAt, meetings }));
    } catch { /* offline: the last copy stays */ }
    render();
  }
  function show() { render(); if (Date.now() - fetchedAt > 120000) refresh(); }

  // ---- the briefing -----------------------------------------------------------------------------
  const lastSeen = new Map(); // person id -> latest past history item
  async function lastOf(id) {
    if (lastSeen.has(id)) return lastSeen.get(id);
    try {
      const res = await fetch(location.origin + '/people/history?id=' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + tok() }, signal: AbortSignal.timeout(15000) });
      const items = res.ok ? (await res.json()).history || [] : [];
      lastSeen.set(id, items.filter((h) => h.date && h.date <= ymd(new Date())).sort((a, b) => b.date.localeCompare(a.date))[0] || null);
    } catch { return null; }
    return lastSeen.get(id) || null;
  }
  const tasksOf = (id) => (window.CCTasks ? CCTasks.forPerson(id) : []);
  const link = (label, href) => { const a = el('a', 'btn', label); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };

  function personCard(p) {
    const card = el('section', 'card');
    const name = el('h2', '', p.name); name.style.cssText = 'font-size:17px;margin:0;text-decoration:underline;cursor:pointer';
    name.onclick = () => { $('meetSheet').classList.add('hidden'); if (window.CCRecent) CCRecent.openPerson(p.id); };
    card.append(name, el('div', 'muted', [p.role, p.company].filter(Boolean).join(' · ')));
    const sum = el('div', '', p.summary || 'No history summary yet.'); sum.style.cssText = 'white-space:pre-wrap;margin:8px 0' + (p.summary ? '' : ';color:var(--mute)');
    card.append(sum);
    const open = tasksOf(p.id);
    const lc = p.last_contact ? new Date(p.last_contact + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'none logged';
    card.append(el('div', 'muted', 'Last contact: ' + lc + ' · ' + (open.length ? open.length + ' open task' + (open.length === 1 ? '' : 's') : 'no open tasks')));
    const last = el('div', 'muted'); last.style.marginTop = '4px'; card.append(last);
    lastOf(p.id).then((h) => { if (h) last.textContent = 'Last: ' + h.date + ', ' + String(h.type || '').toLowerCase() + ': ' + (h.summary ? h.summary.replace(/\s*Auto-logged from Gmail:.*$/s, '').slice(0, 140) : h.title); });
    const acts = el('div', 'row'); acts.style.marginTop = '8px';
    if (p.phone) acts.append(link('📞', 'tel:' + p.phone.replace(/[^\d+]/g, '')), link('💬', 'https://wa.me/' + p.phone.replace(/\D/g, '')));
    if (p.email) acts.append(link('✉', 'mailto:' + p.email));
    if (p.linkedin) acts.append(link('LinkedIn', p.linkedin));
    if (acts.childNodes.length) card.append(acts);
    return card;
  }

  async function openBriefing(m) {
    if (locked() && !(await CCLock.unlock())) return;
    render();
    current = m;
    $('mb-title').textContent = m.title;
    $('mb-when').textContent = [when(m), m.type].filter(Boolean).join(' · ');
    $('mb-topics').textContent = m.topics ? 'Notes so far:\n' + m.topics : '';
    $('mb-notion').href = m.url;
    $('mb-note').value = ''; $('mb-fu').value = ''; $('mb-msg').textContent = '';
    const box = $('mb-people'); box.replaceChildren();
    const people = m.attendee_ids.map(person).filter(Boolean);
    for (const p of people) box.append(personCard(p));
    const unknown = m.attendee_ids.length - people.length;
    if (unknown > 0) box.append(el('div', 'muted', unknown + ' attendee' + (unknown === 1 ? ' is' : 's are') + ' not in the phone\'s copy of People yet. Open People once to load them.'));
    for (const c of m.company_ids.map(company).filter(Boolean)) {
      const card = el('section', 'card'); const h = el('h2', '', c.name); h.style.cssText = 'font-size:17px;margin:0;text-decoration:underline;cursor:pointer';
      h.onclick = () => { $('meetSheet').classList.add('hidden'); if (window.CCCompanies) CCCompanies.openById(c.id); };
      card.append(h, el('div', 'muted', [c.relationship, c.industry, c.location].filter(Boolean).join(' · ') || 'Company'));
      if (c.why) card.append(el('div', '', c.why));
      box.append(card);
    }
    if (!m.attendee_ids.length && !m.company_ids.length) {
      const card = el('section', 'card'); card.append(el('div', '', 'No attendees linked yet.'), el('div', 'muted', 'Open the meeting in Notion and add them under Attendees. The scheduled task "CRM: link meeting attendees" does this from your calendar once it is switched on.'));
      box.append(card);
    }
    const hasPeople = m.attendee_ids.length > 0;
    $('mb-fu-wrap').classList.toggle('hidden', !hasPeople);
    $('meetSheet').classList.remove('hidden'); $('meetSheet').scrollTop = 0;
  }

  // ---- notes after the meeting ------------------------------------------------------------------
  const apply = (id, topics) => {
    const m = meetings.find((x) => x.id === id);
    if (m) { m.topics = topics; store.set(KEY, JSON.stringify({ at: fetchedAt, meetings })); }
    if (current && current.id === id) { current.topics = topics; $('mb-topics').textContent = topics ? 'Notes so far:\n' + topics : ''; }
  };
  const localTopics = (m, note, today) => (m.topics ? m.topics + '\n' : '') + today + ': ' + note;
  async function save() {
    const m = current; const note = $('mb-note').value.trim(); const days = $('mb-fu').value;
    if (!m || (!note && !days)) { $('mb-msg').textContent = 'Write a note or pick a follow-up date.'; return; }
    $('mb-save').disabled = true; $('mb-msg').textContent = 'Saving…';
    const today = ymd(new Date()); let queued = false;
    if (note) {
      const body = { id: m.id, note, today };
      try {
        const res = await fetch(location.origin + '/meetings/notes', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok() }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        const data = await res.json().catch(() => ({}));
        if (res.ok) apply(m.id, data.meeting.topics);
        else if (res.status === 429 || res.status >= 500) throw new Error('retry');
        else { $('mb-msg').textContent = 'Not saved: ' + (data.error || 'error ' + res.status); $('mb-save').disabled = false; return; }
      } catch { CCOutbox.add({ kind: 'meeting-notes', path: '/meetings/notes', body, label: 'Notes for ' + m.title }); apply(m.id, localTopics(m, note, today)); queued = true; }
    }
    if (days && window.CCRecent && CCRecent.quickUpdate) {
      const d = new Date(); d.setDate(d.getDate() + Number(days));
      for (const id of m.attendee_ids) { if ((await CCRecent.quickUpdate(id, { next_followup: ymd(d) })) === 'queued') queued = true; }
    }
    $('mb-note').value = ''; $('mb-fu').value = '';
    $('mb-msg').textContent = queued ? 'No signal: saved on this phone. It goes to Notion by itself when you are online.' : 'Saved to Notion.';
    $('mb-save').disabled = false;
  }

  function init() {
    if (!$('meetCard')) return;
    $('mb-close').onclick = () => $('meetSheet').classList.add('hidden');
    $('mb-save').onclick = save;
    if (window.CCOutbox) CCOutbox.handle('meeting-notes', { done(op, data) { if (data.meeting) apply(op.body.id, data.meeting.topics); }, failed() { refresh(); } });
    render(); refresh();
    setTimeout(render, 1500); // the phone's People copy may still be loading
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') show(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.CCMeet = { show, render, refresh };
})();
