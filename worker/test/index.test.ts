import { describe, expect, it } from 'vitest';
import worker, { parseRequest } from '../src/index';
import type { Env } from '../src/types';
import { FakeNotion, rich, title } from './fake-notion';

const env: Env = {
  ANTHROPIC_API_KEY: 'sk-test',
  NOTION_TOKEN: 'secret',
  CAPTURE_TOKEN: 'correct horse',
  ALLOWED_ORIGIN: 'https://me.github.io',
  NOTION_PEOPLE_DB: 'p',
  NOTION_COMPANIES_DB: 'c',
  NOTION_INTERACTIONS_DB: 'i',
};

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://w.test${path}`, init), env);
const post = (headers: Record<string, string>, body: unknown) =>
  call('/capture', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('access control', () => {
  it('answers the health check without credentials', async () => {
    expect((await call('/health')).status).toBe(200);
  });
  it('rejects a missing or wrong token', async () => {
    expect((await post({}, { text: 'x' })).status).toBe(401);
    expect((await post({ Authorization: 'Bearer nope' }, { text: 'x' })).status).toBe(401);
  });
  it('rejects browsers from other origins even with the right token', async () => {
    const res = await post({ Authorization: 'Bearer correct horse', Origin: 'https://evil.example' }, { text: 'x' });
    expect(res.status).toBe(403);
  });
  it('answers CORS preflight only for the allowed origin', async () => {
    const ok = await call('/capture', { method: 'OPTIONS', headers: { Origin: 'https://me.github.io' } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://me.github.io');
    const bad = await call('/capture', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
  });
  it('accepts any origin from a comma separated list', async () => {
    const multi = { ...env, ALLOWED_ORIGIN: 'https://a.github.io, https://b.github.io' };
    for (const origin of ['https://a.github.io', 'https://b.github.io']) {
      const res = await worker.fetch(new Request('https://w.test/capture', { method: 'OPTIONS', headers: { Origin: origin } }), multi);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    const bad = await worker.fetch(new Request('https://w.test/capture', { method: 'OPTIONS', headers: { Origin: 'https://c.github.io' } }), multi);
    expect(bad.status).toBe(403);
  });
  it('rejects oversized bodies even without a Content-Length header', async () => {
    const res = await call('/capture', {
      method: 'POST',
      headers: { Authorization: 'Bearer correct horse' },
      body: 'x'.repeat(12 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
  });
  it('rejects bodies that are not valid requests', async () => {
    const res = await post({ Authorization: 'Bearer correct horse' }, { images: [] });
    expect(res.status).toBe(400);
  });
});

describe('serving the app', () => {
  const assets = { fetch: async (r: Request) => new Response(`asset:${new URL(r.url).pathname}`) } as unknown as Fetcher;
  it('serves static files for any other path', async () => {
    const res = await worker.fetch(new Request('https://w.test/index.html'), { ...env, ASSETS: assets });
    expect(await res.text()).toBe('asset:/index.html');
  });
  it('redirects a share POST that reaches the Worker to the app', async () => {
    const res = await call('/share-target', { method: 'POST', body: 'x', redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('https://w.test/');
  });
  it('accepts requests from the same origin the app is served from', async () => {
    const res = await post({ Authorization: 'Bearer correct horse', Origin: 'https://w.test' }, { images: [] });
    expect(res.status).toBe(400); // reached validation, so origin and token were accepted
  });
  it('still rejects other sites', async () => {
    const res = await post({ Authorization: 'Bearer correct horse', Origin: 'https://evil.example' }, { text: 'x' });
    expect(res.status).toBe(403);
  });
  it('only allows POST on /capture', async () => {
    expect((await call('/capture')).status).toBe(405);
  });
});

describe('parseRequest', () => {
  const ok = { media_type: 'image/jpeg', data: 'AAAA' };
  it('accepts images and defaults', () => {
    expect(parseRequest({ images: [ok] }, '2026-10-26')).toEqual({
      images: [ok],
      text: '',
      note: '',
      today: '2026-10-26',
      log_meeting: false, // a meeting is only logged when asked for
    });
  });
  it('accepts text only and trims note', () => {
    expect(parseRequest({ text: ' sig ', note: ' met ', today: '2026-01-02', log_meeting: false }, 'x')).toMatchObject({
      text: 'sig',
      note: 'met',
      today: '2026-01-02',
      log_meeting: false,
    });
  });
  it('logs a meeting only for photos and only when asked', () => {
    expect(parseRequest({ images: [ok], log_meeting: true }, 'x')).toMatchObject({ log_meeting: true });
    expect(parseRequest({ images: [ok], log_meeting: false }, 'x')).toMatchObject({ log_meeting: false });
    expect(parseRequest({ images: [ok] }, 'x')).toMatchObject({ log_meeting: false });
    // an email signature is never a meeting, even if the client says so
    expect(parseRequest({ text: 'sig', log_meeting: true }, 'x')).toMatchObject({ log_meeting: false });
    expect(parseRequest({ text: 'sig', images: [ok], log_meeting: true }, 'x')).toMatchObject({ log_meeting: true });
  });
  it('rejects bad media types, bad base64 and too many images', () => {
    expect(typeof parseRequest({ images: [{ media_type: 'application/pdf', data: 'AAAA' }] }, 'x')).toBe('string');
    expect(typeof parseRequest({ images: [{ media_type: 'image/png', data: 'not base64!' }] }, 'x')).toBe('string');
    expect(typeof parseRequest({ images: Array(13).fill(ok) }, 'x')).toBe('string');
    expect(typeof parseRequest({ images: Array(12).fill(ok) }, 'x')).toBe('object'); // a bulk run of 12 photos is fine
    expect(typeof parseRequest({}, 'x')).toBe('string');
  });
});

describe('my sharing details', () => {
  const notion = new FakeNotion();
  const meEnv = { ...env, NOTION_ME_DB: 'me-db' };
  const authed = { Authorization: 'Bearer correct horse' };
  const row = (detail: string, value: string, type: string, groups: string[], order: number, label = '') =>
    notion.seed('me-db', {
      Detail: title(detail),
      Value: rich(value),
      Type: { select: { name: type } },
      Groups: { multi_select: groups.map((name) => ({ name })) },
      Label: rich(label),
      Order: { number: order },
    });
  const phone = row('Work phone', '+34 600', 'Phone', ['Professional'], 22);
  row('First name', 'Matthias', 'First name', [], 1);
  row('Mobile', '', 'Phone', ['Personal'], 10);
  const other = notion.seed('people-db', { Name: title('Somebody else') });

  const callMe = (path: string, init: RequestInit = {}) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    return worker.fetch(new Request(`https://w.test${path}`, init), meEnv).finally(() => (globalThis.fetch = realFetch));
  };

  it('requires the access token', async () => {
    expect((await callMe('/me')).status).toBe(401);
    expect((await callMe('/me/update', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('lists the rows in order, including empty ones', async () => {
    const res = await callMe('/me', { headers: authed });
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: any[] };
    expect(items.map((i) => i.detail)).toEqual(['First name', 'Mobile', 'Work phone']);
    expect(items[2]).toMatchObject({ value: '+34 600', type: 'Phone', groups: ['Professional'] });
  });
  it('updates a value and can clear it', async () => {
    const res = await callMe('/me/update', { method: 'POST', headers: authed, body: JSON.stringify({ id: phone.id, value: ' +34 611 ' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).item.value).toBe('+34 611');
    const cleared = await callMe('/me/update', { method: 'POST', headers: authed, body: JSON.stringify({ id: phone.id, value: '' }) });
    expect(((await cleared.json()) as any).item.value).toBe('');
  });
  it('refuses to edit a page that belongs to another database', async () => {
    const res = await callMe('/me/update', { method: 'POST', headers: authed, body: JSON.stringify({ id: other.id, value: 'x' }) });
    expect(res.status).toBe(404);
    expect(other.properties.Value).toBeUndefined();
  });
  it('rejects malformed update requests and wrong methods', async () => {
    expect((await callMe('/me/update', { method: 'POST', headers: authed, body: JSON.stringify({ id: 'x', value: 1 }) })).status).toBe(400);
    expect((await callMe('/me', { method: 'POST', headers: authed })).status).toBe(405);
  });
});
