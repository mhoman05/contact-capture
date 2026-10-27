// "Save to phone contacts": the person is added to your Google Contacts by the service (Android syncs them to the phone).
// If that is not set up or fails, a contact file (vCard) goes to the phone's share sheet; where sharing files is not possible it is downloaded.
(() => {
  'use strict';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');

  /** p: { name, company, role, phone, email, linkedin, telegram, note } */
  function one(p) {
    const name = String(p.name || '').trim();
    if (!name) return '';
    const parts = name.split(/\s+/);
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : name;
    const L = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(last)};${esc(first)};;;`, `FN:${esc(name)}`];
    if (p.company) L.push(`ORG:${esc(p.company)}`);
    if (p.role) L.push(`TITLE:${esc(p.role)}`);
    if (p.phone) L.push(`TEL;TYPE=CELL:${esc(p.phone)}`);
    if (p.email) L.push(`EMAIL;TYPE=INTERNET:${esc(p.email)}`);
    if (p.linkedin) L.push(`URL:${String(p.linkedin).replace(/[\r\n]/g, '')}`);
    if (p.telegram) L.push(`item1.URL:${String(p.telegram).replace(/[\r\n]/g, '')}`, 'item1.X-ABLabel:Telegram');
    if (p.note) L.push(`NOTE:${esc(p.note)}`);
    L.push('END:VCARD');
    return L.join('\r\n') + '\r\n';
  }
  const make = (list) => list.map(one).join('');

  async function share(list) {
    const people = list.filter((p) => p && p.name);
    if (!people.length) return 'Nothing to save.';
    const base = people.length === 1 ? people[0].name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, '-').replace(/^-|-$/g, '') : 'contacts';
    const file = new File([make(people)], (base || 'contact') + '.vcf', { type: 'text/x-vcard' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: people.length === 1 ? people[0].name : people.length + ' contacts' }); return ''; }
    } catch (e) { if (e && e.name === 'AbortError') return ''; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.append(a); a.click(); a.remove();
    return 'Downloaded. Open the file to add the contact.';
  }

  /** Saves one person to Google Contacts; falls back to the contact file when that is not possible. Returns a message for the screen. */
  async function addToContacts(p) {
    if (!p || !p.name) return 'Nothing to save.';
    let failure = '';
    try {
      let tok = ''; try { tok = localStorage.getItem('cc.tok') || ''; } catch { /* no storage */ }
      const body = { name: p.name, company: p.company, role: p.role, phone: p.phone, email: p.email, linkedin: p.linkedin, telegram: p.telegram, location: p.location, note: p.note };
      const res = await fetch(location.origin + '/contacts/google', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (res.ok) return j.status === 'exists' ? 'Already in your Google Contacts.' : 'Saved to Google Contacts. It shows up in your phone\'s Contacts within a minute.';
      failure = res.status === 503 ? '' : (j.error || 'Google Contacts did not answer.');
    } catch { failure = 'No connection, so a contact file is offered instead.'; }
    const fallback = await share([p]);
    return [failure, fallback].filter(Boolean).join(' ');
  }

  window.CCVcard = { make, one, share, addToContacts };
})();
