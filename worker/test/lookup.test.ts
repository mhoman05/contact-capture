import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { lookup, pageTitle, parseLookupRequest } from '../src/lookup';
import type { Env } from '../src/types';

const env: Env = { ANTHROPIC_API_KEY: 'k', NOTION_TOKEN: 's', CAPTURE_TOKEN: 'correct horse', NOTION_PEOPLE_DB: 'p', NOTION_COMPANIES_DB: 'c', NOTION_INTERACTIONS_DB: 'i' };
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { Location: to } });
const page = (html: string, status = 200) => new Response(html, { status });

describe('parseLookupRequest', () => {
  it('accepts only LinkedIn and WhatsApp addresses', () => {
    expect(parseLookupRequest({ url: 'https://lnkd.in/dAbC123' })).toBeInstanceOf(URL);
    expect(parseLookupRequest({ url: 'https://www.linkedin.com/in/jane-doe' })).toBeInstanceOf(URL);
    expect(parseLookupRequest({ url: 'https://wa.me/qr/ABC' })).toBeInstanceOf(URL);
    for (const bad of ['https://evil.example/', 'https://linkedin.com.evil.example/', 'http://169.254.169.254/', 'ftp://lnkd.in/x', 'nope', '']) {
      expect(typeof parseLookupRequest({ url: bad })).toBe('string');
    }
    expect(typeof parseLookupRequest({})).toBe('string');
    expect(typeof parseLookupRequest(null)).toBe('string');
  });
});

describe('pageTitle', () => {
  it('prefers og:title, in either attribute order, and decodes entities', () => {
    expect(pageTitle('<head><title>x</title><meta property="og:title" content="Jane Doe - Head of Sales - Acme &amp; Co | LinkedIn"></head>')).toBe('Jane Doe - Head of Sales - Acme & Co | LinkedIn');
    expect(pageTitle('<meta content="Ana M&#xED;a" property="og:title">')).toBe('Ana Mía');
    expect(pageTitle('<title> Just  a title </title>')).toBe('Just a title');
    expect(pageTitle('<p>nothing</p>')).toBe('');
  });
});

describe('lookup', () => {
  it('follows redirects between the allowed hosts and reads the title', async () => {
    const seen: string[] = [];
    const f = (async (input: any) => {
      seen.push(String(input));
      if (String(input).startsWith('https://lnkd.in/')) return redirect('https://www.linkedin.com/in/jane-doe-1a2b3c?trk=qr');
      return page('<meta property="og:title" content="Jane Doe - Sales | LinkedIn">');
    }) as typeof fetch;
    const r = await lookup(new URL('https://lnkd.in/dAbC123'), f);
    expect(seen).toEqual(['https://lnkd.in/dAbC123', 'https://www.linkedin.com/in/jane-doe-1a2b3c?trk=qr']);
    expect(r).toEqual({ url: 'https://www.linkedin.com/in/jane-doe-1a2b3c?trk=qr', title: 'Jane Doe - Sales | LinkedIn', status: 200 });
  });
  it('does not follow a redirect to another host', async () => {
    const seen: string[] = [];
    const f = (async (input: any) => { seen.push(String(input)); return redirect('https://evil.example/steal'); }) as typeof fetch;
    const r = await lookup(new URL('https://lnkd.in/x'), f);
    expect(seen).toHaveLength(1);
    expect(r.title).toBe('');
  });
  it('stops after a few redirects', async () => {
    const f = (async () => redirect('https://lnkd.in/again')) as typeof fetch;
    expect((await lookup(new URL('https://lnkd.in/x'), f)).status).toBe(310);
  });
  it('reports a blocked page without a title', async () => {
    const f = (async () => page('<html></html>', 403)) as typeof fetch;
    expect(await lookup(new URL('https://www.linkedin.com/in/x'), f)).toEqual({ url: 'https://www.linkedin.com/in/x', title: '', status: 403 });
  });
});

describe('POST /scan/lookup', () => {
  const call = (body: unknown, headers: Record<string, string> = { Authorization: 'Bearer correct horse' }) =>
    worker.fetch(new Request('https://w.test/scan/lookup', { method: 'POST', headers, body: JSON.stringify(body) }), env);
  it('needs the access token and a LinkedIn or WhatsApp address', async () => {
    expect((await call({ url: 'https://lnkd.in/x' }, {})).status).toBe(401);
    expect((await call({ url: 'https://evil.example/' })).status).toBe(400);
  });
  it('returns where the link ends up', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any) => (String(input).startsWith('https://lnkd.in/') ? redirect('https://www.linkedin.com/in/jane-doe') : page('<title>Jane Doe | LinkedIn</title>'))) as typeof fetch;
    try {
      const res = await call({ url: 'https://lnkd.in/x' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: 'https://www.linkedin.com/in/jane-doe', title: 'Jane Doe | LinkedIn', status: 200 });
    } finally {
      globalThis.fetch = real;
    }
  });
  it('says so when the site cannot be reached', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('boom'); }) as typeof fetch;
    try {
      expect((await call({ url: 'https://lnkd.in/x' })).status).toBe(502);
    } finally {
      globalThis.fetch = real;
    }
  });
});
