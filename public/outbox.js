// Changes made without signal (editing a person, logging a meeting or interaction, saving to Google Contacts) wait here on
// the phone and are sent, in order, as soon as the service can be reached. Captures from photos have their own queue (queue.js).
(() => {
  'use strict';
  const KEY = 'cc.outbox', FAILED = 'cc.outbox.failed', MAX_TRIES = 30;
  const read = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or off */ } };
  const token = () => { try { return localStorage.getItem('cc.tok') || ''; } catch { return ''; } };

  const handlers = {};
  const listeners = [];
  let flushing = false;
  const notify = () => listeners.forEach((fn) => { try { fn(); } catch { /* a listener must not stop the queue */ } });

  const outbox = {
    /** kind: what the op is ('person', 'log', 'gcontact'); handlers[kind] = { done(op, data), failed(op, message) }. */
    handle(kind, h) { handlers[kind] = h; },
    onChange(fn) { listeners.push(fn); },
    all: () => read(KEY),
    count(kind) { return read(KEY).filter((o) => !kind || o.kind === kind).length; },
    /** op: { kind, path, body, label, personId? } */
    add(op) {
      const list = read(KEY);
      const saved = { ...op, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), tries: 0 };
      list.push(saved); write(KEY, list); notify();
      return saved.id;
    },
    failures: () => read(FAILED),
    clearFailures() { write(FAILED, []); notify(); },
    /** Sends what is waiting. Stops quietly when there is no connection; a rejected change is dropped and reported. */
    async flush() {
      if (flushing || !token()) return;
      flushing = true;
      try {
        const blocked = new Set(); // a person's edits go in order: if one waits, the later ones wait too
        for (const op of read(KEY)) {
          if (op.personId && blocked.has(op.personId)) continue;
          let res, data = {};
          try {
            res = await fetch(location.origin + op.path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: JSON.stringify(op.body), signal: AbortSignal.timeout(30000) });
            data = await res.json().catch(() => ({}));
          } catch { break; } // no connection: keep everything, try again later
          const drop = () => write(KEY, read(KEY).filter((o) => o.id !== op.id));
          if (res.ok) { drop(); try { handlers[op.kind]?.done?.(op, data); } catch { /* the change is saved either way */ } continue; }
          if (res.status === 401) break; // wrong token: nothing can be sent until it is fixed
          const message = data.error || 'The service said no (' + res.status + ').';
          if (res.status === 429 || res.status >= 500) {
            const list = read(KEY); const mine = list.find((o) => o.id === op.id);
            if (mine && ++mine.tries >= MAX_TRIES) { write(KEY, list.filter((o) => o.id !== op.id)); outbox._fail(op, message); }
            else write(KEY, list);
            if (op.personId) blocked.add(op.personId);
            continue;
          }
          drop(); outbox._fail(op, message);
        }
      } finally { flushing = false; notify(); }
    },
    _fail(op, message) {
      write(FAILED, [...read(FAILED), { at: Date.now(), kind: op.kind, label: op.label || 'A change', message }].slice(-20));
      try { handlers[op.kind]?.failed?.(op, message); } catch { /* reported already */ }
    },
  };

  window.addEventListener('online', () => outbox.flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') outbox.flush(); });
  window.CCOutbox = outbox;
})();
