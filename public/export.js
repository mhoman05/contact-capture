// Settings → "Export everything": reads every database through the service and saves ONE zip file with
//   spreadsheets (CSV) of People, Companies, Tasks, Interactions, Meetings and Events, contacts.vcf (everyone, importable into
//   Google Contacts or any phone), backup.json (everything with all ids) and a short README.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d = '') { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
  };
  const enc = new TextEncoder();
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  // ---- a zip file without compression (so no library is needed) -------------------------------------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

  /** files: [{ name, data: Uint8Array }] -> Uint8Array of a .zip */
  function zip(files, now = new Date()) {
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const head = Uint8Array.from([0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)]);
      parts.push(head, name, f.data);
      central.push(Uint8Array.from([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(time), ...u16(date), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += head.length + name.length + size;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = Uint8Array.from([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
    let at = 0; for (const p of all) { out.set(p, at); at += p.length; }
    return out;
  }

  // ---- spreadsheets ---------------------------------------------------------------------------
  const cell = (v) => {
    let t = v == null ? '' : Array.isArray(v) ? v.join('; ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    if (/^[=+\-@\t\r]/.test(t) && !/^[+\-]?[\d\s().]+$/.test(t)) t = "'" + t; // stops a spreadsheet from running text that looks like a formula
    return /[",\r\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  /** columns: [[heading, row => value]] */
  const csv = (rows, columns) => '﻿' + [columns.map(([h]) => cell(h)).join(','), ...rows.map((r) => columns.map(([, f]) => cell(f(r))).join(','))].join('\r\n') + '\r\n';

  // ---- reading everything ---------------------------------------------------------------------
  async function get(path) {
    const tok = store.get('cc.tok');
    if (!tok) throw new Error('Connect the service first (⚙ Access token).');
    let res;
    try { res = await fetch(location.origin + path, { headers: { Authorization: 'Bearer ' + tok } }); } catch { throw new Error('No connection. Try again when you are online.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'The service said no (' + res.status + ').'), { status: res.status });
    return data;
  }
  async function getAll(path, key, progress) {
    const out = []; let cursor = '';
    do {
      const sep = path.includes('?') ? '&' : '?';
      const data = await get(path + (cursor ? sep + 'cursor=' + encodeURIComponent(cursor) : ''));
      out.push(...(data[key] || [])); cursor = data.next_cursor || '';
      progress(out.length);
    } while (cursor);
    return out;
  }

  async function build(progress) {
    const skipped = [];
    const step = async (label, fn) => { progress('Reading ' + label + '…'); try { return await fn((n) => progress('Reading ' + label + '… ' + n)); } catch (e) { if (e.status === 503 || e.status === 404) { skipped.push(label); return []; } throw e; } };
    const people = await step('people', (p) => getAll('/people/list', 'people', p));
    const companies = await step('companies', (p) => getAll('/companies/list', 'companies', p));
    const tasks = await step('tasks', (p) => getAll('/tasks/list?all=1', 'tasks', p));
    const interactions = await step('interactions', (p) => getAll('/export/interactions', 'rows', p));
    const meetings = await step('meetings', (p) => getAll('/export/meetings', 'rows', p));
    const events = await step('events', async () => (await get('/events')).events || []);

    progress('Making the files…');
    const pname = new Map(people.map((p) => [p.id, p.name])), cname = new Map(companies.map((c) => [c.id, c.name]));
    const who = (ids) => (ids || []).map((id) => pname.get(id) || id);
    const orgs = (ids) => (ids || []).map((id) => cname.get(id) || id);
    const files = [];
    const add = (name, text) => files.push({ name, data: enc.encode(text) });
    add('people.csv', csv(people, [['Name', (p) => p.name], ['Company', (p) => p.company], ['Role', (p) => p.role], ['Email', (p) => p.email], ['Phone', (p) => p.phone], ['LinkedIn', (p) => p.linkedin], ['Telegram', (p) => p.telegram], ['Location', (p) => p.location], ['How we know each other', (p) => p.how], ['Notes', (p) => p.notes], ['Events', (p) => p.events], ['Tier', (p) => p.tier], ['Contact type', (p) => p.contact_type], ['Needs review', (p) => p.needs_review], ['Next follow-up', (p) => p.next_followup], ['Last contact', (p) => p.last_contact], ['Added', (p) => (p.created || '').slice(0, 10)], ['Notion link', (p) => p.url]]));
    add('companies.csv', csv(companies, [['Name', (c) => c.name], ['Website', (c) => c.website], ['LinkedIn', (c) => c.linkedin], ['Location', (c) => c.location], ['Industry', (c) => c.industry], ['Relationship', (c) => c.relationship], ['Priority', (c) => c.priority], ['Why they matter', (c) => c.why], ['Notes', (c) => c.notes], ['People', (c) => who(c.people_ids)], ['Former people', (c) => who(c.former_ids)], ['Added', (c) => (c.created || '').slice(0, 10)], ['Notion link', (c) => c.url]]));
    add('tasks.csv', csv(tasks, [['Task', (t) => t.title], ['Status', (t) => t.status], ['Due', (t) => t.due], ['Completed', (t) => t.completed], ['Waiting on someone else', (t) => t.waiting], ['Type', (t) => t.types], ['Tags', (t) => t.tags], ['People', (t) => who(t.person_ids)], ['Companies', (t) => (t.companies && t.companies.length ? t.companies : orgs(t.company_ids))], ['Notes', (t) => t.notes], ['Next step', (t) => t.next_step], ['Added', (t) => (t.created || '').slice(0, 10)], ['Notion link', (t) => t.url]]));
    add('interactions.csv', csv(interactions, [['Date', (i) => i.date], ['Title', (i) => i.title], ['Type', (i) => i.type], ['Direction', (i) => i.direction], ['People', (i) => who(i.person_ids)], ['Companies', (i) => orgs(i.company_ids)], ['Summary', (i) => i.summary], ['Needs follow-up', (i) => i.needs_followup], ['Notion link', (i) => i.url]]));
    add('meetings.csv', csv(meetings, [['Date', (m) => m.date], ['Title', (m) => m.title], ['Type', (m) => m.type], ['People', (m) => who(m.person_ids)], ['Companies', (m) => orgs(m.company_ids)], ['Topics discussed', (m) => m.topics], ['Notion link', (m) => m.url]]));
    add('events.csv', csv(events, [['Date', (e) => e.date], ['Name', (e) => e.name], ['Type', (e) => e.type], ['Location', (e) => e.location]]));
    if (window.CCVcard) add('contacts.vcf', CCVcard.make(people.map((p) => ({ ...p, note: p.how || '' }))));
    const counts = { people: people.length, companies: companies.length, tasks: tasks.length, interactions: interactions.length, meetings: meetings.length, events: events.length };
    add('backup.json', JSON.stringify({ app: 'Pocket CRM', exported_at: new Date().toISOString(), counts, people, companies, tasks, interactions, meetings, events }, null, 1));
    add('README.txt', [
      'Pocket CRM backup, ' + new Date().toLocaleString(),
      '',
      'people.csv, companies.csv, tasks.csv, interactions.csv, meetings.csv, events.csv  Spreadsheets (open in Excel, Numbers or Google Sheets).',
      'contacts.vcf   Everyone in People as contact cards. To get them into Google Contacts: contacts.google.com → Import → choose this file.',
      'backup.json    Everything, with all ids, for safekeeping or for rebuilding the data somewhere else.',
      '',
      'Counts: ' + Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ') + '.',
      skipped.length ? 'Not included (not set up or not visible to the app): ' + skipped.join(', ') + '.' : '',
      '',
      'Your data lives in Notion. Deleted pages stay in Notion\'s trash for 30 days. This file is your own copy: keep it somewhere safe (Google Drive, email to yourself).',
    ].filter((l) => l !== null).join('\r\n'));
    return { bytes: zip(files), counts, skipped };
  }

  // ---- the button -----------------------------------------------------------------------------
  function refreshInfo() {
    const at = Number(store.get('cc.backup.at', '0'));
    const d = at ? Math.floor((Date.now() - at) / 864e5) : -1;
    const el = $('bkInfo'); if (!el) return;
    el.textContent = !at ? 'No backup made yet.' : 'Last backup: ' + (d <= 0 ? 'today' : d === 1 ? 'yesterday' : d + ' days ago') + '.';
  }
  async function run() {
    const btn = $('bkBtn'), msg = $('bkMsg');
    btn.disabled = true; msg.classList.remove('bad');
    try {
      const { bytes, counts, skipped } = await build((t) => { msg.textContent = t; });
      const name = 'pocket-crm-backup-' + ymd(new Date()) + '.zip';
      const file = new File([bytes], name, { type: 'application/zip' });
      let shared = false;
      try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); shared = true; } }
      catch (e) { if (e && e.name === 'AbortError') { msg.textContent = 'Cancelled.'; btn.disabled = false; return; } }
      if (!shared) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
      store.set('cc.backup.at', String(Date.now()));
      msg.textContent = (shared ? 'Backup ready. ' : 'Saved ' + name + ' in your Downloads. ') + Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ') + '.' + (skipped.length ? ' Not included: ' + skipped.join(', ') + '.' : '') + ' Keep a copy in Google Drive or email it to yourself.';
    } catch (e) { msg.classList.add('bad'); msg.textContent = 'Backup failed: ' + e.message; }
    btn.disabled = false; refreshInfo();
  }
  document.addEventListener('DOMContentLoaded', () => { if ($('bkBtn')) { $('bkBtn').onclick = run; refreshInfo(); } });
  if (document.readyState !== 'loading' && $('bkBtn')) { $('bkBtn').onclick = run; refreshInfo(); }
  const gear = $('gear'); if (gear) gear.addEventListener('click', refreshInfo);

  window.CCExport = { zip, crc32, csv, build };
})();
