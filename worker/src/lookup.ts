// Scanned QR codes of LinkedIn and WhatsApp are often a short link (lnkd.in/…, wa.me/qr/…). The phone cannot follow those
// itself (the sites do not allow it), so the service follows them and reports the address it ends up at and the page title.
// Only a short fixed list of hosts is ever fetched.

const HOSTS = new Set(['lnkd.in', 'linkedin.com', 'www.linkedin.com', 'wa.me', 'api.whatsapp.com', 'whatsapp.com', 'www.whatsapp.com']);
const MAX_HOPS = 4;
const MAX_BODY = 200_000;

export interface LookupResult {
  url: string; // where the link ends up
  title: string; // og:title or <title> of the page, '' when the site did not show one
  status: number; // HTTP status of the last page
}

/** The link to follow, or a message for the app. */
export function parseLookupRequest(body: unknown): URL | string {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).url : undefined;
  if (typeof raw !== 'string' || raw.length > 500) return 'Send {"url": "<address from the QR code>"}.';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'That is not a web address.';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'That is not a web address.';
  if (!HOSTS.has(u.hostname.toLowerCase())) return 'Only LinkedIn and WhatsApp links are looked up.';
  return u;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

/** og:title (either attribute order), otherwise <title>. */
export function pageTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  const t = og?.[1] ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '';
  return decode(t).replace(/\s+/g, ' ').trim().slice(0, 300);
}

export async function lookup(start: URL, fetcher: typeof fetch = fetch): Promise<LookupResult> {
  let u = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetcher(u.href, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PocketCRM link preview)', Accept: 'text/html', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(6000),
    });
    const loc = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && loc) {
      let next: URL;
      try {
        next = new URL(loc, u);
      } catch {
        return { url: u.href, title: '', status: res.status };
      }
      if (!HOSTS.has(next.hostname.toLowerCase()) || (next.protocol !== 'https:' && next.protocol !== 'http:')) return { url: next.href, title: '', status: res.status };
      u = next;
      continue;
    }
    const html = (await res.text().catch(() => '')).slice(0, MAX_BODY);
    return { url: u.href, title: pageTitle(html), status: res.status };
  }
  return { url: u.href, title: '', status: 310 };
}
