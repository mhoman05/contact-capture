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

describe('typed contacts in the request', () => {
  const base = { images: [], text: '', note: 'MERGE', today: '2026-10-26' };
  it('accepts a typed contact on its own and cleans the values', () => {
    const r = parseRequest({ ...base, contact: { name: ' Jane  Doe ', company: 'Acme', phone: '0034 600 111 222', email: 'Jane@Acme.com', telegram: '@janedoe', linkedin: 'linkedin.com/in/janedoe/?utm=x', source: 'qr' } }, 'x');
    expect(r).toMatchObject({ manual: { source: 'a scanned QR code', contact: { full_name: 'Jane Doe', email: 'jane@acme.com', phone: '+34 600 111 222', telegram_url: 'https://t.me/janedoe', linkedin_url: 'https://www.linkedin.com/in/janedoe' } } });
  });
  it('needs a name, and reports values it cannot read instead of dropping them', () => {
    expect(parseRequest({ ...base, contact: { company: 'Acme' } }, 'x')).toMatch(/name/);
    expect(parseRequest({ ...base, contact: { name: 'Jane', email: 'nope', phone: '12' } }, 'x')).toMatch(/email address, phone number/);
    expect(parseRequest({ ...base, contact: { name: 'Jane', telegram: 't.me/+abcdef' } }, 'x')).toMatch(/Telegram/);
  });
  it('keeps LinkedIn short links and rejects other sites', () => {
    const ok = parseRequest({ ...base, contact: { name: 'Jane', linkedin: 'https://lnkd.in/abc123?trk=x' } }, 'x') as any;
    expect(ok.manual.contact.linkedin_url).toBe('https://lnkd.in/abc123');
    expect(parseRequest({ ...base, contact: { name: 'Jane', linkedin: 'https://evil.example/in/jane' } }, 'x')).toMatch(/LinkedIn/);
  });
  it('allows a meeting for a typed contact but never for text alone', () => {
    expect((parseRequest({ ...base, log_meeting: true, contact: { name: 'Jane' } }, 'x') as any).log_meeting).toBe(true);
    expect((parseRequest({ ...base, text: 'Jane Doe', log_meeting: true }, 'x') as any).log_meeting).toBe(false);
  });
  it('still needs something to work with', () => {
    expect(parseRequest(base, 'x')).toMatch(/at least one/i);
  });
});

describe('events', () => {
  const notion = new FakeNotion();
  const evEnv = { ...env, NOTION_EVENTS_DB: 'events-db' };
  const authed = { Authorization: 'Bearer correct horse' };
  const evRow = (name: string, date: string, type = 'Conference') =>
    notion.seed('events-db', { Name: title(name), Date: { date: { start: date } }, Type: { select: { name: type } }, Location: rich('Madrid') });
  const older = evRow('Old meetup', '2026-01-10', 'Meetup');
  const newer = evRow('MERGE Madrid', '2026-10-26');
  const other = notion.seed('people-db', { Name: title('Somebody') });
  const callEv = (path: string, init: RequestInit = {}) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    return worker.fetch(new Request(`https://w.test${path}`, init), evEnv).finally(() => (globalThis.fetch = realFetch));
  };

  it('requires the access token', async () => {
    expect((await callEv('/events')).status).toBe(401);
    expect((await callEv('/events/create', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('lists events newest first', async () => {
    const { events } = (await (await callEv('/events', { headers: authed })).json()) as { events: any[] };
    expect(events.map((e) => e.name)).toEqual(['MERGE Madrid', 'Old meetup']);
    expect(events[0]).toMatchObject({ id: newer.id, date: '2026-10-26', type: 'Conference', location: 'Madrid' });
    expect(older.id).toBeTruthy();
  });
  it('creates an event with sensible defaults', async () => {
    const res = await callEv('/events/create', { method: 'POST', headers: authed, body: JSON.stringify({ name: ' Padel night ', date: 'not a date', type: 'nope' }) });
    expect(res.status).toBe(200);
    const { event } = (await res.json()) as any;
    expect(event).toMatchObject({ name: 'Padel night', type: 'Other' });
    expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(notion.rows.filter((r) => r.db === 'events-db')).toHaveLength(3);
    expect((await callEv('/events/create', { method: 'POST', headers: authed, body: '{}' })).status).toBe(400);
  });
});

describe('notes and events in the capture request', () => {
  const ok = { media_type: 'image/jpeg', data: 'AAAA' };
  it('keeps a note per image and an event id', () => {
    const r = parseRequest({ images: [{ ...ok, note: ' CTO friend ' }, ok], event_id: 'abc-123456', log_meeting: false }, 'x') as any;
    expect(r.images[0].note).toBe('CTO friend');
    expect(r.images[1].note).toBeUndefined();
    expect(r.event_id).toBe('abc-123456');
  });
  it('rejects a malformed event id', () => {
    expect(parseRequest({ images: [ok], event_id: '../../x' }, 'x')).toMatch(/event_id/);
  });
});

describe('recent people', () => {
  const notion = new FakeNotion();
  const pEnv = { ...env, NOTION_PEOPLE_DB: 'people-db', NOTION_COMPANIES_DB: 'companies-db', NOTION_EVENTS_DB: 'events-db' };
  const authed = { Authorization: 'Bearer correct horse' };
  const acme = notion.seed('companies-db', { Name: title('Acme') });
  const ev = notion.seed('events-db', { Name: title('MERGE Madrid'), Date: { date: { start: '2026-10-26' } } });
  const person = (name: string, extra: Record<string, unknown> = {}) => notion.seed('people-db', { Name: title(name), Notes: rich(''), ...extra });
  const first = person('First Added');
  const second = person('Second Added', { Company: { relation: [{ id: acme.id }] }, Events: { relation: [{ id: ev.id }] }, Role: rich('CTO'), 'Needs review': { checkbox: true }, 'Next Follow-up': { date: { start: '2026-11-03' } }, Email: { email: 'a@b.com' } });
  const otherDb = notion.seed('events-db', { Name: title('Not a person') });
  const callP = (path: string, init: RequestInit = {}) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    return worker.fetch(new Request(`https://w.test${path}`, init), pEnv).finally(() => (globalThis.fetch = realFetch));
  };
  const update = (body: unknown) => callP('/people/update', { method: 'POST', headers: authed, body: JSON.stringify(body) });

  it('requires the access token', async () => {
    expect((await callP('/people/recent')).status).toBe(401);
    expect((await callP('/people/update', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('lists the newest people first with company, event and follow-up', async () => {
    const { people } = (await (await callP('/people/recent?limit=50', { headers: authed })).json()) as { people: any[] };
    expect(people.map((p) => p.name)).toEqual(['Second Added', 'First Added']);
    expect(people[0]).toMatchObject({ company: 'Acme', events: ['MERGE Madrid'], role: 'CTO', needs_review: true, next_followup: '2026-11-03', email: 'a@b.com' });
    expect(people[0].created).toMatch(/^2026-/);
    expect(first.id).toBeTruthy();
  });
  it('edits fields, creates a company, appends a dated note and clears a follow-up', async () => {
    const res = await update({ id: first.id, today: '2026-10-28', role: 'Head of Sales', company: 'Globex', phone: '0034 600 111 222', telegram: '@firstadded', note: 'Called, wants a demo', needs_review: false, next_followup: '' });
    expect(res.status).toBe(200);
    const { person: p } = (await res.json()) as any;
    expect(p).toMatchObject({ role: 'Head of Sales', company: 'Globex', phone: '+34 600 111 222', telegram: 'https://t.me/firstadded', needs_review: false, next_followup: '' });
    expect(p.notes).toBe('2026-10-28: Called, wants a demo');
    expect(notion.rows.filter((r) => r.db === 'companies-db').map((r) => r.properties.Name.title[0].text.content)).toContain('Globex');
    await update({ id: first.id, today: '2026-10-29', note: 'Sent the deck' });
    const again = (await (await callP('/people/recent', { headers: authed })).json()) as any;
    expect(again.people.find((x: any) => x.name === 'First Added').notes).toBe('2026-10-28: Called, wants a demo\n2026-10-29: Sent the deck');
  });
  it('clears a value when sent an empty string, and sets a new follow-up date', async () => {
    const { person: p } = (await (await update({ id: second.id, email: '', company: '', next_followup: '2026-11-10' })).json()) as any;
    expect(p).toMatchObject({ email: '', company: '', next_followup: '2026-11-10' });
  });
  it('refuses pages from other databases and bad values', async () => {
    expect((await update({ id: otherDb.id, role: 'x' })).status).toBe(404);
    expect((await update({ id: first.id, email: 'nope', phone: '1' })).status).toBe(400);
    expect((await update({ id: first.id, name: '  ' })).status).toBe(400);
    expect((await update({ id: first.id })).status).toBe(400);
    expect((await update({ id: first.id, next_followup: 'tomorrow' })).status).toBe(400);
  });
});

describe('follow-up date in the capture request', () => {
  const ok = { media_type: 'image/jpeg', data: 'AAAA' };
  it('accepts a sensible number of days only', () => {
    expect((parseRequest({ images: [ok], follow_up_days: 7 }, 'x') as any).follow_up_days).toBe(7);
    for (const bad of [0, -1, 1.5, 400, '7']) expect((parseRequest({ images: [ok], follow_up_days: bad }, 'x') as any).follow_up_days).toBeUndefined();
  });
});
