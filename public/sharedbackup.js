// Shared backup of the phone apps in Notion ("App backups"), seen from Pocket CRM. Pocket CRM itself keeps almost everything in Notion;
// what lives only on this phone (saved scans, My QR choices, hidden duplicate pairs, your settings) is saved here. The same screen
// shows when My Day and Racket Rankings were last backed up.
/* Shared backup client. The same code runs in My Day, Racket Rankings and Pocket CRM. Each app compresses its own data and
   sends it to the Pocket CRM service, which keeps it in the Notion database "App backups". */
const SharedBackup = (() => {
  const DEFAULT_URL = 'https://contact-capture.matthias-homan.workers.dev';
  const K = { url: 'sb.url', tok: 'sb.token', auto: 'sb.autoAt', last: 'sb.lastOk' };
  const get = (k, d = '') => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };
  const NAMES = { myday: 'My Day', rankings: 'Racket Rankings', crm: 'Pocket CRM' };
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  const api = {
    NAMES,
    url: () => (get(K.url) || DEFAULT_URL).replace(/\/+$/, ''),
    token: () => get(K.tok),
    configured: () => !!get(K.tok),
    setup(url, token) { set(K.url, (url || '').trim()); set(K.tok, (token || '').trim()); },
    lastOk: () => Number(get(K.last, '0')) || 0,
    device() { const m = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(navigator.userAgent); return m && m[1] && m[1] !== 'K' ? m[1] : /Android/.test(navigator.userAgent) ? 'Android phone' : 'Browser'; },
    /** object -> "gz:<base64>" (or "raw:" when the browser cannot compress). */
    async pack(obj) {
      const bytes = new TextEncoder().encode(JSON.stringify(obj));
      if (typeof CompressionStream === 'function') return 'gz:' + b64(await pipe(bytes, new CompressionStream('gzip')));
      return 'raw:' + b64(bytes);
    },
    async unpack(str) {
      const raw = unb64(str.slice(str.indexOf(':') + 1));
      const bytes = str.startsWith('gz:') ? await pipe(raw, new DecompressionStream('gzip')) : raw;
      return JSON.parse(new TextDecoder().decode(bytes));
    },
    async call(path, init = {}) {
      let res;
      try { res = await fetch(api.url() + path, { ...init, headers: { Authorization: 'Bearer ' + api.token(), ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(45000) }); }
      catch { throw new Error('Could not reach the Pocket CRM service. Check the signal and the address.'); }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(res.status === 401 ? 'The access token is wrong. Use the same token as Pocket CRM.' : data.error || `The service said no (${res.status}).`);
      return data;
    },
    async save(app, obj) {
      const data = await api.pack(obj);
      const res = await api.call('/backup/save', { method: 'POST', body: JSON.stringify({ app, data, device: api.device() }) });
      set(K.last, String(Date.now()));
      return res.backup;
    },
    async load(app) { const r = await api.call('/backup/load?app=' + app); return { ...r, object: await api.unpack(r.data) }; },
    async list() { return (await api.call('/backup/list')).backups; },
    /** Once a day when the app is opened (and it has something to save). Silent: never throws. */
    async auto(app, makeObject) {
      if (!api.configured() || !navigator.onLine) return false;
      if (Date.now() - (Number(get(K.auto, '0')) || 0) < 20 * 3600 * 1000) return false;
      try { const o = makeObject(); if (!o) return false; set(K.auto, String(Date.now())); await api.save(app, o); return true; } catch { set(K.auto, '0'); return false; }
    },
    /** "3 hours ago" style label. */
    ago(iso) { const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); if (!(m >= 0)) return ''; if (m < 2) return 'just now'; if (m < 90) return m + ' minutes ago'; if (m < 36 * 60) return Math.round(m / 60) + ' hours ago'; return Math.round(m / 1440) + ' days ago'; },
  };
  return api;
})();

// Pocket CRM is the service itself: it calls its own address and uses the access token it already has.
SharedBackup.url = () => location.origin;
SharedBackup.token = () => { try { return localStorage.getItem('cc.tok') || ''; } catch { return ''; } };
SharedBackup.configured = () => !!SharedBackup.token();

(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEYS = ['cc.fu', 'cc.auto', 'cc.meet', 'cc.scans', 'cc.me.over', 'cc.me.groups', 'cc.dupe.no', 'cc.log.type', 'cc.p.sort', 'cc.p.mode', 'cc.c.sort', 'cc.t.filter', 'cc.t.list'];
  const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage full or off */ } };
  /** What is only on this phone. Never the access token or the lock, and not the waiting changes (replaying old ones later could undo newer edits). */
  function makeObject() {
    const keys = {};
    for (const k of KEYS) { const v = read(k); if (v != null) keys[k] = v; }
    return { app: 'crm', version: 1, exportedAt: Date.now(), keys };
  }
  /** Fills in what is missing and joins lists (saved scans, hidden pairs); a setting that is already set here is left alone. Returns how many keys changed. */
  function merge(d) {
    if (!d || d.app !== 'crm' || typeof d.keys !== 'object') throw new Error('not a backup from Pocket CRM');
    let n = 0;
    for (const [k, v] of Object.entries(d.keys)) {
      if (!KEYS.includes(k) || typeof v !== 'string') continue;
      const mine = read(k);
      if (mine == null || mine === '') { write(k, v); n++; continue; }
      try {
        const a = JSON.parse(mine), b = JSON.parse(v);
        if (Array.isArray(a) && Array.isArray(b)) {
          const seen = new Set(a.map((x) => JSON.stringify(x))), add = b.filter((x) => !seen.has(JSON.stringify(x)));
          if (add.length) { write(k, JSON.stringify([...a, ...add])); n++; }
        }
      } catch { /* a plain setting: keep this phone's value */ }
    }
    return n;
  }

  let list = null;
  const msg = (t, bad) => { const m = $('sbMsg'); if (!m) return; m.textContent = t; m.classList.toggle('bad', !!bad); };
  function show() {
    const el = $('sbList'); if (!el) return;
    el.innerHTML = '';
    if (!list) return;
    for (const [k, n] of Object.entries(SharedBackup.NAMES)) {
      const b = list.find((x) => x.app === k), row = document.createElement('div');
      row.className = 'muted'; row.style.margin = '2px 0';
      const old = b && Date.now() - new Date(b.at).getTime() > 7 * 864e5;
      row.textContent = n + ': ' + (b ? SharedBackup.ago(b.at) + ' · ' + b.size_kb + ' KB' + (b.device ? ' · ' + b.device : '') : 'no backup yet');
      if (old || !b) row.style.color = 'var(--warn, #b45309)';
      el.appendChild(row);
    }
  }
  async function refresh() {
    if (!SharedBackup.configured()) { list = null; show(); return; }
    try { list = await SharedBackup.list(); } catch (e) { list = null; msg(e.message, true); }
    show();
  }
  async function backupNow() {
    const btn = $('sbBtn'); btn.disabled = true; msg('Backing up…');
    try { const b = await SharedBackup.save('crm', makeObject()); msg('Backed up (' + b.size_kb + ' KB).'); } catch (e) { msg(e.message, true); }
    btn.disabled = false; refresh();
  }
  async function restore() {
    if (!confirm('Add the latest Pocket CRM backup from Notion to this phone? Settings you already have here stay as they are.')) return;
    msg('Restoring…');
    try { const r = await SharedBackup.load('crm'); const n = merge(r.object); msg('Restored ' + n + ' setting' + (n === 1 ? '' : 's') + ' from the backup of ' + new Date(r.at).toLocaleString() + (n ? '. Reload the app to see them.' : '.')); } catch (e) { msg(e.message, true); }
  }
  function bind() {
    if (!$('sbBtn')) return;
    $('sbBtn').onclick = backupNow; $('sbRestore').onclick = restore;
    const gear = $('gear'); if (gear) gear.addEventListener('click', () => { msg(''); refresh(); });
    SharedBackup.auto('crm', makeObject);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
  window.CCSharedBackup = { makeObject, merge, refresh };
})();
