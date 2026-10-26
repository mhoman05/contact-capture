// Pure helpers: cleaning what the model read off a card, and comparing it with what the CRM already holds.

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'ltd', 'limited', 'llc', 'llp', 'lp', 'plc', 'corp', 'corporation', 'co',
  'gmbh', 'ag', 'sa', 'sl', 'slu', 'bv', 'nv', 'ab', 'oy', 'as', 'spa', 'srl', 'sarl', 'sas', 'kg',
]);

/** Lower-case, strip accents, collapse everything that is not a letter or digit to single spaces. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function nameTokens(name: string): string[] {
  return fold(name).split(' ').filter(Boolean);
}

/** Same person name, ignoring accents, case, punctuation and word order ("Rütter, Benedikt" = "Benedikt Rutter"). */
export function sameName(a: string, b: string): boolean {
  const ta = nameTokens(a).sort().join(' ');
  const tb = nameTokens(b).sort().join(' ');
  return ta !== '' && ta === tb;
}

/**
 * One name is a strict subset of the other with at least two shared words
 * ("Álvaro Durán" vs "Álvaro Durán Casares"): probably the same person, but not safe to merge automatically.
 */
export function similarName(a: string, b: string): boolean {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size < 2 || tb.size < 2) return false;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size === big.size) return false;
  return [...small].every((t) => big.has(t));
}

export function companyKey(name: string): string {
  const tokens = fold(name).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(' ');
}

export function cleanEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  const v = s.trim().replace(/^mailto:/i, '').replace(/[<>\s]/g, '').toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v) ? v : null;
}

export function linkedInSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.trim().match(/linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

export function cleanLinkedIn(url: string | null | undefined): string | null {
  const slug = linkedInSlug(url);
  return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}` : null;
}

export function cleanWebsite(s: string | null | undefined): string | null {
  if (!s) return null;
  let v = s.trim();
  if (!v || /\s/.test(v)) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const u = new URL(v);
    return u.hostname.includes('.') ? `${u.protocol}//${u.hostname}${u.pathname === '/' ? '' : u.pathname}` : null;
  } catch {
    return null;
  }
}

export function cleanPhone(s: string | null | undefined): string | null {
  if (!s) return null;
  let v = s.trim().replace(/^tel:/i, '').replace(/[^\d+()\-.\s]/g, '').replace(/\s+/g, ' ').trim();
  if (v.startsWith('00')) v = `+${v.slice(2)}`;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? v : null;
}

export function phoneDigits(s: string): string {
  return s.replace(/\D/g, '');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function nonEmpty(s: string | null | undefined, max = 200): string | null {
  const v = (s ?? '').replace(/\s+/g, ' ').trim();
  return v ? truncate(v, max) : null;
}

/** A Telegram profile as https://t.me/<username>. Accepts t.me / telegram.me links, tg://resolve?domain=, or @username. Group invite links are not profiles. */
export function cleanTelegram(s: string | null | undefined): string | null {
  const v = (s ?? '').trim();
  if (!v) return null;
  let name: string | undefined;
  const at = v.match(/^@([A-Za-z][A-Za-z0-9_]{4,31})$/);
  if (at) name = at[1];
  const tg = v.match(/^tg:\/\/resolve\?(?:[^#]*&)?domain=([A-Za-z][A-Za-z0-9_]{4,31})(?:&|$)/i);
  if (!name && tg) name = tg[1];
  const web = v.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?(?:[?#].*)?$/i);
  if (!name && web) name = web[1];
  return name ? `https://t.me/${name}` : null;
}

export function telegramHandle(url: string | null | undefined): string | null {
  return url?.match(/t\.me\/([A-Za-z0-9_]+)/i)?.[1].toLowerCase() ?? null;
}

/** A LinkedIn profile address. A normal /in/ link becomes the canonical profile address; other links on linkedin.com or lnkd.in (short links from the app's QR code) are kept as they are, without tracking parameters. */
export function cleanLinkedInLink(s: string | null | undefined): string | null {
  const canonical = cleanLinkedIn(s);
  if (canonical) return canonical;
  const v = (s ?? '').trim();
  if (!v || /\s/.test(v)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (host === 'lnkd.in' || host === 'linkedin.com' || host.endsWith('.linkedin.com')) return `https://${u.hostname}${u.pathname}`;
  } catch {
    /* not a URL */
  }
  return null;
}
