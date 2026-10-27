// "Save to phone contacts": a contact file (vCard) for one or more people, handed to the phone's share sheet.
// Choosing Contacts there opens the usual "save contact" screen; where sharing files is not possible the file is downloaded instead.
(() => {
  'use strict';
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\;').replace(/,/g, '\\,');

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

  window.CCVcard = { make, one, share };
})();
