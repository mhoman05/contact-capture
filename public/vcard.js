// "Save to phone contacts". On Android, one person opens the Contacts app's "new contact" screen with the details filled in.
// Otherwise (or if that does not open) a contact file (vCard) goes to the phone's share sheet; where sharing files is not possible it is downloaded.
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

  /** Android "create contact" screen, prefilled. p: as for one(). */
  function intentUrl(p) {
    const notes = [p.note, p.linkedin && 'LinkedIn: ' + p.linkedin, p.telegram && 'Telegram: ' + p.telegram].filter(Boolean).join('\n');
    const extras = [['name', p.name], ['phone', p.phone], ['email', p.email], ['company', p.company], ['job_title', p.role], ['postal', p.location], ['notes', notes]]
      .filter(([, v]) => v && String(v).trim());
    return 'intent:#Intent;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/contact;' + extras.map(([k, v]) => `S.${k}=${encodeURIComponent(String(v).trim())}`).join(';') + ';end';
  }

  /** Opens the new-contact screen; if the page is still in front a moment later (the phone did not open it), falls back to the share sheet. */
  async function addToContacts(p) {
    if (!p || !p.name) return 'Nothing to save.';
    if (!/Android/i.test(navigator.userAgent)) return share([p]);
    let left = false;
    const gone = () => { left = true; };
    document.addEventListener('visibilitychange', gone); window.addEventListener('pagehide', gone); window.addEventListener('blur', gone);
    try {
      const a = document.createElement('a'); a.href = intentUrl(p); document.body.append(a); a.click(); a.remove();
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      document.removeEventListener('visibilitychange', gone); window.removeEventListener('pagehide', gone); window.removeEventListener('blur', gone);
    }
    return left ? '' : share([p]);
  }

  window.CCVcard = { make, one, share, intentUrl, addToContacts };
})();
