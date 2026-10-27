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

/** GET /v?c=<base64url vCard>. Public on purpose: it only reflects a validated contact card. */
export function vcardResponse(param: string | null): Response {
  const text = param ? decodeBase64Url(param) : null;
  const checked = text == null ? 'This link is not valid.' : checkVcard(text);
  if (typeof checked === 'string') return new Response(checked, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(checked.vcard, {
    status: 200,
    headers: {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': `inline; filename="${checked.filename}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    },
  });
}
