// Share link for the "My QR" card: the app puts the contact card (a vCard) into the link, and this endpoint hands it back as
// a .vcf file, so whoever opens the link in a browser or messenger gets "add contact". Nothing is stored. The text is checked
// line by line so the endpoint can only ever return a plain contact card, never arbitrary content.

const MAX_CHARS = 4000;
const PROPS = new Set(['N', 'FN', 'ORG', 'TITLE', 'TEL', 'EMAIL', 'URL', 'ADR', 'NOTE', 'X-ABLABEL']);

export function decodeBase64Url(s: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s) || s.length > MAX_CHARS * 2) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

const unescapeValue = (s: string) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

/** The checked contact card and a file name for it, or a short reason it was refused. */
export function checkVcard(text: string): { vcard: string; filename: string } | string {
  if (text.length > MAX_CHARS) return 'Contact card too large.';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return 'Contact card has invalid characters.';
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter((l) => l !== '');
  if (lines[0] !== 'BEGIN:VCARD' || lines[1] !== 'VERSION:3.0' || lines[lines.length - 1] !== 'END:VCARD') return 'Not a contact card.';
  let fn = '';
  for (const line of lines.slice(2, -1)) {
    const m = line.match(/^(?:item\d+\.)?([A-Za-z-]+)((?:;[A-Za-z0-9=,_-]+)*):(.*)$/);
    if (!m) return 'Not a contact card.';
    const prop = m[1].toUpperCase();
    if (!PROPS.has(prop)) return 'Not a contact card.';
    if (prop === 'URL' && !/^https?:\/\/[^\s]+$/i.test(m[3])) return 'Not a contact card.';
    if (prop === 'FN' && !fn) fn = unescapeValue(m[3]);
  }
  if (!fn) return 'The contact card has no name.';
  const base = fn.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'contact';
  return { vcard: lines.join('\r\n') + '\r\n', filename: `${base.slice(0, 60)}.vcf` };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

interface Card {
  name: string;
  org: string;
  title: string;
  lines: { kind: 'tel' | 'email' | 'url' | 'adr' | 'note'; label: string; value: string }[];
}

/** The readable parts of a card that checkVcard has already accepted. */
function readCard(vcard: string): Card {
  const card: Card = { name: '', org: '', title: '', lines: [] };
  const labels = new Map<string, string>();
  const rows = vcard.split(/\r?\n/).filter(Boolean).slice(2, -1).map((l) => l.match(/^(?:(item\d+)\.)?([A-Za-z-]+)((?:;[A-Za-z0-9=,_-]+)*):(.*)$/)!);
  for (const m of rows) if (m[2].toUpperCase() === 'X-ABLABEL') labels.set(m[1], unescapeValue(m[4]));
  for (const m of rows) {
    const prop = m[2].toUpperCase();
    const value = unescapeValue(m[4]);
    const label = (m[1] && labels.get(m[1])) || (/TYPE=[^;]*WORK/i.test(m[3]) ? 'Work' : /TYPE=[^;]*(HOME|CELL)/i.test(m[3]) ? (/CELL/i.test(m[3]) ? 'Mobile' : 'Home') : '');
    if (prop === 'FN') card.name ||= value;
    else if (prop === 'ORG') card.org ||= value;
    else if (prop === 'TITLE') card.title ||= value;
    else if (prop === 'TEL') card.lines.push({ kind: 'tel', label, value });
    else if (prop === 'EMAIL') card.lines.push({ kind: 'email', label, value });
    else if (prop === 'URL') card.lines.push({ kind: 'url', label, value: m[4] });
    else if (prop === 'ADR') card.lines.push({ kind: 'adr', label, value: value.split(';').filter(Boolean).join(', ') });
    else if (prop === 'NOTE') card.lines.push({ kind: 'note', label: 'Note', value });
  }
  return card;
}

/** A small page: who this is, and one big button that downloads the contact file (phones then offer "add to contacts"). */
function cardPage(vcard: string, fileHref: string): string {
  const c = readCard(vcard);
  const rows = c.lines
    .map((l) => {
      const v = esc(l.value);
      const body =
        l.kind === 'tel' ? `<a href="tel:${esc(l.value.replace(/[^\d+]/g, ''))}">${v}</a>` :
        l.kind === 'email' ? `<a href="mailto:${v}">${v}</a>` :
        l.kind === 'url' ? `<a href="${v}" rel="noopener">${esc(l.value.replace(/^https?:\/\/(www\.)?/, ''))}</a>` : v;
      return `<div class="r"><span>${esc(l.label || (l.kind === 'tel' ? 'Phone' : l.kind === 'email' ? 'Email' : l.kind === 'url' ? 'Link' : l.kind === 'adr' ? 'Address' : ''))}</span>${body}</div>`;
    })
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(c.name)}: contact details</title>
<style>:root{--bg:#f5f6f3;--card:#fff;--ink:#1a2220;--mute:#65706b;--line:#e2e5e0;--accent:#1f6f5c}@media(prefers-color-scheme:dark){:root{--bg:#121615;--card:#1b2120;--ink:#e8ecE9;--mute:#98a39e;--line:#2b3331;--accent:#4fb89c}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px 16px}main{max-width:460px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}h1{font-size:24px;margin:0}.sub{color:var(--mute);margin:2px 0 14px}.r{display:flex;gap:12px;padding:9px 0;border-top:1px solid var(--line)}.r span{flex:none;width:5.5em;color:var(--mute)}.r a{color:var(--accent);overflow-wrap:anywhere}
.btn{display:block;text-align:center;margin-top:18px;padding:15px;border-radius:12px;background:var(--accent);color:#fff;font-weight:700;text-decoration:none;font-size:17px}.hint{color:var(--mute);font-size:14px;margin-top:12px}</style></head>
<body><main><div class="card"><h1>${esc(c.name)}</h1><div class="sub">${esc([c.title, c.org].filter(Boolean).join(' · '))}</div>${rows}
<a class="btn" href="${esc(fileHref)}">Add to contacts</a>
<p class="hint">Tap the button, then open the downloaded contact file; your phone offers to save it to your contacts. If nothing opens, find the file in your Downloads and tap it.</p></div></main></body></html>`;
}

/** GET /v?c=<base64url vCard>: a page with an "Add to contacts" button; with &f=1 the contact file itself. Public on purpose. */
export function vcardResponse(param: string | null, wantFile = false): Response {
  const text = param ? decodeBase64Url(param) : null;
  const checked = text == null ? 'This link is not valid.' : checkVcard(text);
  if (typeof checked === 'string') return new Response(checked, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (wantFile) {
    return new Response(checked.vcard, {
      status: 200,
      headers: {
        'Content-Type': 'text/vcard; charset=utf-8',
        // As a download, so phones hand the file to the contacts app instead of showing it as text.
        'Content-Disposition': `attachment; filename="${checked.filename}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  }
  return new Response(cardPage(checked.vcard, `/v?c=${encodeURIComponent(param!)}&f=1`), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
