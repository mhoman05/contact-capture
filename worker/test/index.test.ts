import { describe, expect, it } from 'vitest';
import worker, { parseRequest } from '../src/index';
import type { Env } from '../src/types';

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

describe('parseRequest', () => {
  const ok = { media_type: 'image/jpeg', data: 'AAAA' };
  it('accepts images and defaults', () => {
    expect(parseRequest({ images: [ok] }, '2026-10-26')).toEqual({
      images: [ok],
      text: '',
      note: '',
      today: '2026-10-26',
      log_meeting: true,
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
  it('rejects bad media types, bad base64 and too many images', () => {
    expect(typeof parseRequest({ images: [{ media_type: 'application/pdf', data: 'AAAA' }] }, 'x')).toBe('string');
    expect(typeof parseRequest({ images: [{ media_type: 'image/png', data: 'not base64!' }] }, 'x')).toBe('string');
    expect(typeof parseRequest({ images: Array(7).fill(ok) }, 'x')).toBe('string');
    expect(typeof parseRequest({}, 'x')).toBe('string');
  });
});
