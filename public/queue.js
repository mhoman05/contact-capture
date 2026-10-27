// Capture without signal: when sending fails because there is no connection (or the service has a hiccup), the capture
// is kept on this phone (IndexedDB, photos included) and sent by itself as soon as the app is open and online again.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  };
  const cfg = () => ({ url: (store.get('cc.url') || location.origin).replace(/\/+$/, ''), tok: store.get('cc.tok') });
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // ---- IndexedDB ------------------------------------------------------------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('cc-queue', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }
  const tx = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('items', mode); const out = fn(t.objectStore('items')); t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined); t.onerror = () => rej(t.error); }); };
  const list = async () => { const rows = (await tx('readonly', (s) => s.getAll())) || []; return rows.sort((a, b) => a.at - b.at); };
  const put = (item) => tx('readwrite', (s) => s.put(item));
  const del = (id) => tx('readwrite', (s) => s.delete(id));

  // ---- sending --------------------------------------------------------------
  const retryable = (status) => status === 429 || status >= 500;
  let flushing = false;

  async function add(body, label) {
    const item = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), at: Date.now(), body, label, error: '' };
    await put(item);
    await render();
    return item;
  }

  async function flush() {
    if (flushing || !cfg().tok) return { sent: 0 };
    const items = await list();
    if (!items.length) return { sent: 0 };
    flushing = true; setBusy(true);
    const results = [], errors = []; let sent = 0, stopped = false;
    for (const it of items) {
      try {
        const c = new AbortController(); const timer = setTimeout(() => c.abort(), 120000);
        const res = await fetch(cfg().url + '/capture', { method: 'POST', signal: c.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg().tok }, body: JSON.stringify(it.body) }).finally(() => clearTimeout(timer));
        const data = await res.json().catch(() => ({}));
        if (res.ok) { await del(it.id); sent++; results.push(...(data.results || [])); errors.push(...(data.errors || [])); }
        else if (retryable(res.status)) { it.error = data.error || 'The service had a problem (' + res.status + '). Will try again.'; await put(it); stopped = true; break; }
        else { it.error = res.status === 401 ? 'The access token was not accepted. Check it under ⚙.' : (data.error || 'Rejected (' + res.status + ').'); it.rejected = true; await put(it); }
      } catch { stopped = true; break; } // no connection: keep everything and try again later
    }
    flushing = false; setBusy(false);
    await render();
    if (sent && window.ccRender) { window.ccRender({ results, errors }); if (window.CCRecent) CCRecent.invalidate(); }
    return { sent, stopped };
  }

  // ---- the "waiting to send" card ---------------------------------------------
  function setBusy(b) { $('qSend').disabled = b; $('qSend').textContent = b ? 'Sending…' : 'Send now'; }
  async function render() {
    const items = await list();
    $('queue').classList.toggle('hidden', !items.length);
    $('qTitle').textContent = items.length + (items.length === 1 ? ' capture waiting to send' : ' captures waiting to send');
    const box = $('qList'); box.replaceChildren();
    for (const it of items) {
      const row = el('div', 'item');
      const head = el('div'); head.append(el('b', '', it.label || 'Capture'), el('span', 'muted', ' · ' + new Date(it.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      row.append(head);
      if (it.error) row.append(el('div', it.rejected ? 'err' : 'muted', it.error));
      const rm = el('button', 'chip', 'Remove'); rm.type = 'button'; rm.style.marginTop = '6px';
      rm.onclick = async () => { if (confirm('Remove this capture without sending it? The photos are deleted from this phone.')) { await del(it.id); render(); } };
      row.append(rm); box.append(row);
    }
  }
  $('qSend').onclick = () => flush();
  $('qShow').onclick = () => { $('qList').classList.toggle('hidden'); $('qShow').textContent = $('qList').classList.contains('hidden') ? 'Show' : 'Hide'; };

  // ---- when to try ------------------------------------------------------------
  window.addEventListener('online', () => flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
  setInterval(() => { if (navigator.onLine !== false) flush(); }, 45000);
  window.CCQueue = { add, flush, list, count: async () => (await list()).length };
  render().then(() => flush()).catch(() => { /* IndexedDB unavailable (private mode): the queue simply stays off */ });
})();
