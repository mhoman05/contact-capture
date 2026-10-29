import { beforeEach, describe, expect, it } from 'vitest';
import worker, { isValidCursor, parseRequest } from '../src/index';
import type { Env } from '../src/types';
import { FakeNotion, rich, title } from './fake-notion';

const env: Env = {
  ANTHROPIC_API_KEY: 'sk-test',
  NOTION_TOKEN: 'secret',
  CAPTURE_TOKEN: 'correct horse',
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

describe('people', () => {
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
    expect((await callP('/people/list')).status).toBe(401);
    expect((await callP('/people/update', { method: 'POST', body: '{}' })).status).toBe(401);
  });
  it('lists people with company, event and follow-up', async () => {
    const { people } = (await (await callP('/people/list', { headers: authed })).json()) as { people: any[] };
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
    const again = (await (await callP('/people/list', { headers: authed })).json()) as any;
    expect(again.people.find((x: any) => x.name === 'First Added').notes).toBe('2026-10-28: Called, wants a demo\n2026-10-29: Sent the deck');
  });
  it('does not add the same dated note twice when a request is repeated', async () => {
    const body = { id: second.id, today: '2026-11-01', note: 'Retry me' };
    await update(body);
    const { person } = (await (await update(body)).json()) as any;
    expect(person.notes.split('\n').filter((l: string) => l === '2026-11-01: Retry me')).toHaveLength(1);
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

describe('delete, duplicates and merge', () => {
  const authed = { Authorization: 'Bearer correct horse' };
  let notion: FakeNotion;
  const dEnv = { ...env, NOTION_PEOPLE_DB: 'people-db', NOTION_COMPANIES_DB: 'companies-db', NOTION_INTERACTIONS_DB: 'interactions-db', NOTION_EVENTS_DB: 'events-db' };
  const call = (path: string, body?: unknown) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    const init: RequestInit = body === undefined ? { headers: authed } : { method: 'POST', headers: authed, body: JSON.stringify(body) };
    return worker.fetch(new Request(`https://w.test${path}`, init), dEnv).finally(() => (globalThis.fetch = realFetch));
  };
  const person = (name: string, extra: Record<string, unknown> = {}) => notion.seed('people-db', { Name: title(name), Notes: rich(''), ...extra });
  const meeting = (titleText: string, ...people: string[]) => notion.seed('interactions-db', { Title: title(titleText), People: { relation: people.map((id) => ({ id })) } });
  beforeEach(() => { notion = new FakeNotion(); });

  describe('delete', () => {
    it('trashes the person and the meetings only they were in, leaves shared meetings', async () => {
      const ann = person('Ann One');
      const bob = person('Bob Two');
      const solo = meeting('Met Ann One at MERGE', ann.id);
      const shared = meeting('Call with Ann and Bob', ann.id, bob.id);
      const sharedMet = meeting('Met Ann One and friends', ann.id, bob.id);
      const res = await call('/people/delete', { id: ann.id });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).removed).toMatchObject({ person: 'Ann One', meetings: 1, company: false });
      expect(ann.archived && solo.archived).toBe(true);
      expect(shared.archived || sharedMet.archived || bob.archived).toBeFalsy();
    });
    it('trashes a company the capture created, but only if nobody else uses it', async () => {
      const co = notion.seed('companies-db', { Name: title('Newco') });
      const ann = person('Ann One', { Company: { relation: [{ id: co.id }] } });
      const bob = person('Bob Two', { Company: { relation: [{ id: co.id }] } });
      expect(((await (await call('/people/delete', { id: ann.id, company_id: co.id })).json()) as any).removed.company).toBe(false);
      expect(co.archived).toBeFalsy();
      expect(((await (await call('/people/delete', { id: bob.id, company_id: co.id })).json()) as any).removed.company).toBe(true);
      expect(co.archived).toBe(true);
    });
    it('refuses pages that are not people, and is safe to repeat', async () => {
      const co = notion.seed('companies-db', { Name: title('Acme') });
      expect((await call('/people/delete', { id: co.id })).status).toBe(404);
      expect(co.archived).toBeFalsy();
      const ann = person('Ann One');
      expect((await call('/people/delete', { id: ann.id })).status).toBe(200);
      expect((await call('/people/delete', { id: ann.id })).status).toBe(200);
      expect((await call('/people/delete', { id: '..' })).status).toBe(400);
    });
    it('needs the access token', async () => {
      expect((await worker.fetch(new Request('https://w.test/people/delete', { method: 'POST', body: '{}' }), dEnv)).status).toBe(401);
      expect((await worker.fetch(new Request('https://w.test/people/duplicates'), dEnv)).status).toBe(401);
      expect((await worker.fetch(new Request('https://w.test/people/merge', { method: 'POST', body: '{}' }), dEnv)).status).toBe(401);
    });
  });

  describe('duplicates', () => {
    it('finds pairs by email, phone, LinkedIn, Telegram and name, strongest first, with a suggestion which to keep', async () => {
      person('Jane Doe', { Email: { email: 'jane@acme.com' } });
      person('J. Doe', { Email: { email: 'JANE@acme.com' }, Role: rich('CEO'), Phone: { phone_number: '+34 600 111 222' } });
      person('Pedro Ruiz', { Phone: { phone_number: '600 111 222' } });
      person('Lena Voss', { LinkedIn: { url: 'https://www.linkedin.com/in/lenavoss' } });
      person('Elena V.', { LinkedIn: { url: 'https://linkedin.com/in/lenavoss/' } });
      person('Tom Stark', { Telegram: { url: 'https://t.me/tomstark' } });
      person('Thomas S', { Telegram: { url: 'https://t.me/TomStark' } });
      person('Álvaro Durán');
      person('Alvaro Duran Casares', { Role: rich('CTO') });
      person('Sam Lee', { Email: { email: 'sam@a.com' } });
      person('Sam Lee', { Email: { email: 'sam@b.com' } }); // same name, different emails: different people
      const { pairs } = (await (await call('/people/duplicates')).json()) as { pairs: any[] };
      const reasons = pairs.map((p) => `${p.a.name}+${p.b.name}:${p.reasons.join('&')}:${p.strength}`);
      expect(reasons).toContain('Jane Doe+J. Doe:Same email:high');
      expect(reasons.some((r) => r.startsWith('J. Doe+Pedro Ruiz') && r.includes('Same phone number'))).toBe(true);
      expect(reasons.some((r) => r.includes('Same LinkedIn profile'))).toBe(true);
      expect(reasons.some((r) => r.includes('Same Telegram'))).toBe(true);
      expect(reasons.some((r) => r.includes('Álvaro Durán') && r.includes('Similar name') && r.endsWith('medium'))).toBe(true);
      expect(reasons.some((r) => r.startsWith('Sam Lee+Sam Lee'))).toBe(false);
      const jane = pairs.find((p) => p.reasons.includes('Same email'))!;
      expect(jane[jane.keep].name).toBe('J. Doe'); // the one with more details
      expect(pairs[0].strength).toBe('high');
      expect(pairs.at(-1).strength).toBe('medium');
    });
  });

  describe('merge', () => {
    it('fills empty fields, moves links and notes, unions tags, and trashes the duplicate last', async () => {
      const ev1 = notion.seed('events-db', { Name: title('MERGE Madrid') });
      const ev2 = notion.seed('events-db', { Name: title('Web Summit') });
      const co = notion.seed('companies-db', { Name: title('Acme') });
      const keep = person('Jane Doe', { Email: { email: 'jane@acme.com' }, Notes: rich('2026-10-01: first note'), Events: { relation: [{ id: ev1.id }] }, 'Contact Type': { multi_select: [{ name: 'Peer' }] } });
      const gone = person('J. Doe', { Phone: { phone_number: '+34 600' }, Email: { email: 'other@x.com' }, Role: rich('CEO'), Company: { relation: [{ id: co.id }] }, Events: { relation: [{ id: ev1.id }, { id: ev2.id }, { id: keep.id }] }, Notes: rich('2026-10-02: dup note'), 'Contact Type': { multi_select: [{ name: 'Client' }, { name: 'Peer' }] } });
      const res = await call('/people/merge', { keep_id: keep.id, remove_id: gone.id, today: '2026-10-28' });
      expect(res.status).toBe(200);
      const { person: p } = (await res.json()) as any;
      expect(p).toMatchObject({ name: 'Jane Doe', email: 'jane@acme.com', phone: '+34 600', role: 'CEO', company: 'Acme' });
      expect(keep.properties.Events.relation.map((r: any) => r.id)).toEqual([ev1.id, ev2.id]);
      expect(keep.properties['Contact Type'].multi_select.map((o: any) => o.name).sort()).toEqual(['Client', 'Peer']);
      expect(p.notes).toContain('2026-10-01: first note');
      expect(p.notes).toContain('Merged with duplicate "J. Doe"');
      expect(p.notes).toContain('dup note');
      expect(gone.archived).toBe(true);
      expect(keep.archived).toBeFalsy();
    });
    it('refuses the same person twice and pages from other databases', async () => {
      const a = person('A One');
      const co = notion.seed('companies-db', { Name: title('Acme') });
      expect((await call('/people/merge', { keep_id: a.id, remove_id: a.id })).status).toBe(400);
      expect((await call('/people/merge', { keep_id: a.id, remove_id: co.id })).status).toBe(404);
      expect(co.archived).toBeFalsy();
    });
  });
});

describe('browsing people', () => {
  const authed = { Authorization: 'Bearer correct horse' };
  let notion: FakeNotion;
  const bEnv = { ...env, NOTION_PEOPLE_DB: 'people-db', NOTION_COMPANIES_DB: 'companies-db', NOTION_INTERACTIONS_DB: 'interactions-db', NOTION_EVENTS_DB: 'events-db', NOTION_MEETINGS_DB: 'meetings-db' };
  const call = (path: string, body?: unknown) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    const init: RequestInit = body === undefined ? { headers: authed } : { method: 'POST', headers: authed, body: JSON.stringify(body) };
    return worker.fetch(new Request(`https://w.test${path}`, init), bEnv).finally(() => (globalThis.fetch = realFetch));
  };
  beforeEach(() => { notion = new FakeNotion(); });

  it('needs the access token', async () => {
    expect((await worker.fetch(new Request('https://w.test/people/list'), bEnv)).status).toBe(401);
    expect((await worker.fetch(new Request('https://w.test/people/history?id=abcdef'), bEnv)).status).toBe(401);
  });

  it('pages through every person, 100 at a time, with tier and tags', async () => {
    for (let i = 0; i < 230; i++) notion.seed('people-db', { Name: title(`Person ${i}`), ...(i === 0 ? { Tier: { select: { name: 'A - Key' } }, 'Contact Type': { multi_select: [{ name: 'Client' }] } } : {}) });
    const all: any[] = [];
    let cursor: string | null = '';
    let calls = 0;
    while (cursor !== null) {
      const res = await call(`/people/list${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { people: any[]; next_cursor: string | null };
      all.push(...data.people);
      cursor = data.next_cursor;
      calls++;
    }
    expect(calls).toBe(3);
    expect(new Set(all.map((p) => p.name)).size).toBe(230);
    const first = all.find((p) => p.name === 'Person 0');
    expect(first).toMatchObject({ tier: 'A - Key', contact_type: ['Client'] });
    expect(first.edited).toMatch(/^2026-/);
  });

  it('accepts the opaque, long cursors Notion hands out (with + / : =) and passes them on unchanged', async () => {
    const opaque = 'AbC+dEf/gh:ij==' + 'x'.repeat(300);
    const startCursors: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => {
      if (n?.body) startCursors.push(JSON.parse(String(n.body)).start_cursor);
      return notion.fetch(i, n);
    }) as typeof fetch;
    try {
      for (const path of ['/people/list', '/companies/list']) { // (the tasks route uses the same check)
        const res = await worker.fetch(new Request(`https://w.test${path}?cursor=${encodeURIComponent(opaque)}`, { headers: authed }), bEnv);
        expect(res.status, path).toBe(200);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(startCursors.filter((c) => c === opaque).length).toBeGreaterThanOrEqual(2);
    expect(isValidCursor('')).toBe(false);
    expect(isValidCursor('has space')).toBe(false);
    expect(isValidCursor('x'.repeat(2001))).toBe(false);
  });

  it('with since, returns only people edited after it', async () => {
    const a = notion.seed('people-db', { Name: title('Old Olga') });
    const b = notion.seed('people-db', { Name: title('New Nils') });
    a.edited = '2026-01-01T00:00:00.000Z';
    b.edited = '2026-10-20T00:00:00.000Z';
    const res = await call(`/people/list?since=${encodeURIComponent('2026-06-01T00:00:00.000Z')}`);
    expect(((await res.json()) as any).people.map((p: any) => p.name)).toEqual(['New Nils']);
    expect((await call('/people/list?since=yesterday-ish')).status).toBe(400);
  });

  it('shows meetings and interactions of one person, newest first', async () => {
    const p = notion.seed('people-db', { Name: title('Jack R') });
    notion.seed('meetings-db', { Name: title('Intro call'), Date: { date: { start: '2026-09-01' } }, Type: { select: { name: 'External' } }, 'Topics Discussed': rich('Pricing'), Attendees: { relation: [{ id: p.id }] } });
    notion.seed('interactions-db', { Title: title('Met Jack R at MERGE'), Date: { date: { start: '2026-10-26' } }, Type: { select: { name: 'Event' } }, Summary: rich('Wants a demo'), People: { relation: [{ id: p.id }] } });
    notion.seed('interactions-db', { Title: title('Somebody else'), Date: { date: { start: '2026-10-27' } }, People: { relation: [{ id: 'other' }] } });
    const { history } = (await (await call(`/people/history?id=${p.id}`)).json()) as { history: any[] };
    expect(history.map((h) => `${h.kind}:${h.title}:${h.date}`)).toEqual(['interaction:Met Jack R at MERGE:2026-10-26', 'meeting:Intro call:2026-09-01']);
    expect(history[0]).toMatchObject({ type: 'Event', summary: 'Wants a demo' });
    expect((await call('/people/history?id=..')).status).toBe(400);
  });

  it('sets and clears the tier from the app', async () => {
    const p = notion.seed('people-db', { Name: title('Tier Tina'), Notes: rich('') });
    const set = await call('/people/update', { id: p.id, tier: 'B - Important' });
    expect(((await set.json()) as any).person.tier).toBe('B - Important');
    expect(((await (await call('/people/update', { id: p.id, tier: '' })).json()) as any).person.tier).toBe('');
    expect((await call('/people/update', { id: p.id, tier: 'Z' })).status).toBe(400);
  });
});

describe('share link for the contact card', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const card = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Durán;Álvaro;;;\r\nFN:Álvaro Durán\r\nORG:Acme\\, Inc\r\nTITLE:CEO\r\nTEL;TYPE=WORK,VOICE:+34 600 111 222\r\nEMAIL;TYPE=WORK,INTERNET:a@acme.com\r\nURL:https://linkedin.com/in/alvaro\r\nitem1.URL:https://golf.example/book\r\nitem1.X-ABLabel:Indoor Golf\r\nADR;TYPE=WORK:;;Calle 1\\, Madrid;;;;\r\nNOTE:Founder\\, Indoor Golf\r\nEND:VCARD\r\n';
  const get = (c: string | null, method = 'GET') => call(c === null ? '/v' : `/v?c=${c}`, { method });

  it('opens a page with the details and an "Add to contacts" button, without any access token', async () => {
    const res = await get(b64(card));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('Álvaro Durán');
    expect(html).toContain('CEO · Acme, Inc');
    expect(html).toContain('href="tel:+34600111222"');
    expect(html).toContain('mailto:a@acme.com');
    expect(html).toContain('Indoor Golf'); // the club label
    expect(html).toContain(`href="/v?c=${b64(card)}&amp;f=1"`);
    expect(html).toContain('Download contact file');
  });
  it('rewrites comma-joined TYPE lists, so cards from older versions open fully in Apple Contacts', async () => {
    const old = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Homan;Matthias;;;\r\nFN:Matthias Homan\r\nTEL;TYPE=CELL:+44 770 339 72 64\r\nEMAIL;TYPE=HOME,INTERNET:matthias.homan@gmail.com\r\nADR;TYPE=HOME:;;Calle de Fernandez de la Hoz 35\\, 2D;;;;\r\nURL:https://www.linkedin.com/in/matthias-homan\r\nEND:VCARD\r\n';
    const body = await (await call(`/v?c=${b64(old)}&f=1`)).text();
    expect(body).toContain('EMAIL;TYPE=HOME;TYPE=INTERNET:matthias.homan@gmail.com');
    expect(body).not.toMatch(/TYPE=[A-Za-z]+,/);
    expect(body).toContain('TEL;TYPE=CELL:+44 770 339 72 64');
    expect(body).toContain('URL:https://www.linkedin.com/in/matthias-homan');
    expect(body).toContain('ADR;TYPE=HOME:;;Calle de Fernandez de la Hoz 35\\, 2D;;;;');
  });
  it('escapes everything it shows', async () => {
    const evil = card.replace('FN:Álvaro Durán', 'FN:<img src=x onerror=alert(1)>').replace('NOTE:Founder\\, Indoor Golf', 'NOTE:<script>alert(1)</script>');
    const html = await (await get(b64(evil))).text();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
  it('with f=1 returns the contact file as a download', async () => {
    const res = await call(`/v?c=${b64(card)}&f=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/vcard');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="Alvaro-Duran.vcf"');
    const body = await res.text();
    expect(body).toContain('FN:Álvaro Durán');
    expect(body).toContain('item1.X-ABLabel:Indoor Golf');
    expect(body.endsWith('END:VCARD\r\n')).toBe(true);
  });
  it('refuses anything that is not a plain contact card', async () => {
    const bad = (s: string) => get(b64(s));
    expect((await get(null)).status).toBe(400);
    expect((await get('%%%')).status).toBe(400);
    expect((await bad('<html><script>alert(1)</script></html>')).status).toBe(400);
    expect((await bad(card.replace('TITLE:CEO', 'PHOTO:data:image/png;base64,AAAA'))).status).toBe(400);
    expect((await bad(card.replace('TITLE:CEO', 'X-EVIL:1'))).status).toBe(400);
    expect((await bad(card.replace('https://linkedin.com/in/alvaro', 'javascript:alert(1)'))).status).toBe(400);
    expect((await bad(card.replace('FN:Álvaro Durán\r\n', ''))).status).toBe(400);
    expect((await bad(card + card)).status).toBe(400);
    expect((await bad(card.replace('NOTE:Founder', 'NOTE:' + 'x'.repeat(4100)))).status).toBe(400);
    expect((await get(b64(card), 'POST')).status).toBe(405);
  });
});

describe('tasks', () => {
  const authed = { Authorization: 'Bearer correct horse' };
  let notion: FakeNotion;
  const tEnv = { ...env, NOTION_TASKS_DB: 'tasks-db', NOTION_COMPANIES_DB: 'companies-db', NOTION_PEOPLE_DB: 'people-db' };
  const call = (path: string, body?: unknown) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    const init: RequestInit = body === undefined ? { headers: authed } : { method: 'POST', headers: authed, body: JSON.stringify(body) };
    return worker.fetch(new Request(`https://w.test${path}`, init), tEnv).finally(() => (globalThis.fetch = realFetch));
  };
  const task = (name: string, extra: Record<string, unknown> = {}) => notion.seed('tasks-db', { Name: title(name), Status: { status: { name: 'Not started' } }, ...extra });
  beforeEach(() => { notion = new FakeNotion(); });

  it('needs the access token', async () => {
    for (const [path, method] of [['/tasks/list', 'GET'], ['/tasks/create', 'POST'], ['/tasks/update', 'POST'], ['/tasks/delete', 'POST'], ['/status', 'GET']]) {
      expect((await worker.fetch(new Request(`https://w.test${path}`, { method, body: method === 'POST' ? '{}' : undefined }), tEnv)).status).toBe(401);
    }
  });

  it('lists open tasks and recently edited ones, with company names, not old completed ones', async () => {
    const co = notion.seed('companies-db', { Name: title('Acme') });
    task('Open one', { 'Due Date': { date: { start: '2026-11-02' } }, Type: { multi_select: [{ name: 'Work' }] }, 'Waiting on': { checkbox: true }, 'Company (direct)': { relation: [{ id: co.id }] }, Person: { relation: [{ id: 'p-1' }] }, Notes: rich('call back') });
    const doneRecent = task('Done recently', { Status: { status: { name: 'Done' } } });
    const doneOld = task('Done long ago', { Status: { status: { name: 'Done' } } });
    doneRecent.edited = new Date().toISOString();
    doneOld.edited = '2025-01-01T00:00:00.000Z';
    const { tasks } = (await (await call('/tasks/list')).json()) as { tasks: any[] };
    expect(tasks.map((t) => t.title).sort()).toEqual(['Done recently', 'Open one']);
    expect(tasks.find((t) => t.title === 'Open one')).toMatchObject({ status: 'Not started', due: '2026-11-02', types: ['Work'], waiting: true, companies: ['Acme'], person_ids: ['p-1'], notes: 'call back' });
  });

  it('with since returns only what changed, including tasks that were completed', async () => {
    const a = task('Old');
    const b = task('Changed', { Status: { status: { name: 'Done' } } });
    a.edited = '2026-01-01T00:00:00.000Z';
    b.edited = '2026-10-20T00:00:00.000Z';
    const { tasks } = (await (await call(`/tasks/list?since=${encodeURIComponent('2026-06-01T00:00:00.000Z')}`)).json()) as any;
    expect(tasks.map((t: any) => `${t.title}:${t.status}`)).toEqual(['Changed:Done']);
    expect((await call('/tasks/list?since=never')).status).toBe(400);
  });

  it('creates a task with its links, and returns the existing one when the same task is sent twice', async () => {
    const res = await call('/tasks/create', { title: ' Send the deck ', due: '2026-11-03', types: ['Work'], tags: ['Demos'], waiting: false, person_ids: ['page-123'], notes: 'v2 please' });
    expect(res.status).toBe(200);
    const { task: t } = (await res.json()) as any;
    expect(t).toMatchObject({ title: 'Send the deck', status: 'Not started', due: '2026-11-03', types: ['Work'], tags: ['Demos'], person_ids: ['page-123'], notes: 'v2 please', completed: '' });
    const again = (await (await call('/tasks/create', { title: 'Send the deck' })).json()) as any;
    expect(again.task.id).toBe(t.id);
    expect(notion.rows.filter((r) => r.db === 'tasks-db')).toHaveLength(1);
  });

  it('refuses bad input with a clear message', async () => {
    const msg = async (body: unknown) => ((await (await call('/tasks/create', body)).json()) as any).error as string;
    expect(await msg({})).toMatch(/title/);
    expect(await msg({ title: 'x', due: 'tomorrow' })).toMatch(/due date/);
    expect(await msg({ title: 'x', types: ['Fun'] })).toMatch(/task types/);
    expect(await msg({ title: 'x', status: 'Doing' })).toMatch(/Status/);
    expect(await msg({ title: 'x', person_ids: ['../..'] })).toMatch(/people/);
    expect(await msg({ title: 'x', waiting: 'yes' })).toMatch(/Waiting/);
  });

  it('completes a task (date set), un-completes it (date cleared), and edits other fields', async () => {
    const t = task('Call Jack', { 'Due Date': { date: { start: '2026-10-28' } } });
    const done = (await (await call('/tasks/update', { id: t.id, status: 'Done', today: '2026-10-29' })).json()) as any;
    expect(done.task).toMatchObject({ status: 'Done', completed: '2026-10-29', due: '2026-10-28' });
    const undone = (await (await call('/tasks/update', { id: t.id, status: 'Not started' })).json()) as any;
    expect(undone.task).toMatchObject({ status: 'Not started', completed: '' });
    const edited = (await (await call('/tasks/update', { id: t.id, title: 'Call Jack R', due: '', waiting: true, person_ids: ['page-9'], next_step: 'ask about pricing' })).json()) as any;
    expect(edited.task).toMatchObject({ title: 'Call Jack R', due: '', waiting: true, person_ids: ['page-9'], next_step: 'ask about pricing' });
  });

  it('only touches rows of the Task Database', async () => {
    const person = notion.seed('people-db', { Name: title('Somebody') });
    expect((await call('/tasks/update', { id: person.id, title: 'hacked' })).status).toBe(404);
    expect((await call('/tasks/delete', { id: person.id })).status).toBe(404);
    expect(person.archived).toBeFalsy();
    expect((await call('/tasks/update', { id: person.id })).status).toBe(400);
  });

  it('deletes (trashes) a task and is safe to repeat', async () => {
    const t = task('Remove me');
    expect((await call('/tasks/delete', { id: t.id })).status).toBe(200);
    expect(t.archived).toBe(true);
    expect((await call('/tasks/delete', { id: t.id })).status).toBe(200);
    const { tasks } = (await (await call('/tasks/list')).json()) as any;
    expect(tasks).toHaveLength(0);
  });

  it('reports which databases the connection can see, which connection that is, and what else it can see', async () => {
    const real = notion.fetch;
    notion.fetch = (async (input: any, init: any) => {
      const u = new URL(String(input));
      if (u.pathname === '/v1/users/me') return new Response(JSON.stringify({ name: 'Contact capture', bot: { workspace_name: 'Matthias' } }), { status: 200 });
      if (u.pathname === '/v1/search') return new Response(JSON.stringify({ results: [{ id: 'abc', title: [{ plain_text: 'People' }] }, { id: 'def', title: [] }] }), { status: 200 });
      if (u.pathname === '/v1/databases/tasks-db') return new Response('{}', { status: 404 });
      const m = u.pathname.match(/^\/v1\/databases\/([^/]+)$/);
      if (m) return new Response(JSON.stringify({ id: m[1], title: [{ plain_text: `DB ${m[1]}` }], properties: {} }), { status: 200 });
      return real(input, init);
    }) as typeof fetch;
    const status = (await (await call('/status')).json()) as any;
    const tasks = status.databases.find((d: any) => d.name === 'Tasks');
    expect(tasks.ok).toBe(false);
    expect(tasks.error).toMatch(/Connections/);
    expect(status.databases.find((d: any) => d.name === 'People')).toMatchObject({ ok: true, title: 'DB people-db' });
    expect(status.connection).toEqual({ name: 'Contact capture', workspace: 'Matthias' });
    expect(status.visible).toEqual([{ id: 'abc', title: 'People' }, { id: 'def', title: '(untitled)' }]);
  });
});

describe('history when a source is not connected', () => {
  it('still shows the readable one', async () => {
    const authed = { Authorization: 'Bearer correct horse' };
    const notion = new FakeNotion();
    const person = notion.seed('people-db', { Name: title('Jack R') });
    notion.seed('interactions-db', { Title: title('Met Jack R'), Date: { date: { start: '2026-10-26' } }, People: { relation: [{ id: person.id }] } });
    const real = notion.fetch;
    notion.fetch = (async (input: any, init: any) => (String(input).includes('/databases/meetings-db/') ? new Response('{}', { status: 404 }) : real(input, init))) as typeof fetch;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    const res = await worker.fetch(new Request(`https://w.test/people/history?id=${person.id}`, { headers: authed }), { ...env, NOTION_PEOPLE_DB: 'people-db', NOTION_INTERACTIONS_DB: 'interactions-db', NOTION_MEETINGS_DB: 'meetings-db' }).finally(() => (globalThis.fetch = realFetch));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).history.map((h: any) => h.title)).toEqual(['Met Jack R']);
  });
});

describe('companies', () => {
  const authed = { Authorization: 'Bearer correct horse' };
  let notion: FakeNotion;
  const cEnv = { ...env, NOTION_COMPANIES_DB: 'companies-db', NOTION_INTERACTIONS_DB: 'interactions-db', NOTION_MEETINGS_DB: 'meetings-db', NOTION_PEOPLE_DB: 'people-db' };
  const call = (path: string, body?: unknown) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    const init: RequestInit = body === undefined ? { headers: authed } : { method: 'POST', headers: authed, body: JSON.stringify(body) };
    return worker.fetch(new Request(`https://w.test${path}`, init), cEnv).finally(() => (globalThis.fetch = realFetch));
  };
  const company = (name: string, extra: Record<string, unknown> = {}) => notion.seed('companies-db', { Name: title(name), ...extra });
  beforeEach(() => { notion = new FakeNotion(); });

  it('needs the access token', async () => {
    for (const [path, method] of [['/companies/list', 'GET'], ['/companies/history?id=abcdef', 'GET'], ['/companies/create', 'POST'], ['/companies/update', 'POST']]) {
      expect((await worker.fetch(new Request(`https://w.test${path}`, { method, body: method === 'POST' ? '{}' : undefined }), cEnv)).status).toBe(401);
    }
  });

  it('lists companies with their fields and people, and only what changed with since', async () => {
    const a = company('Acme Inc', { Website: { url: 'https://acme.com' }, Industry: { select: { name: 'Fintech' } }, Relationship: { select: { name: 'Target' } }, 'Target Priority': { select: { name: 'High' } }, 'HQ / Location': rich('Madrid'), 'Why They Matter': rich('Big buyer'), People: { relation: [{ id: 'p1' }, { id: 'p2' }] } });
    const b = company('Old Corp');
    a.edited = '2026-10-20T00:00:00.000Z';
    b.edited = '2026-01-01T00:00:00.000Z';
    const all = (await (await call('/companies/list')).json()) as any;
    expect(all.companies.find((c: any) => c.name === 'Acme Inc')).toMatchObject({ website: 'https://acme.com', industry: 'Fintech', relationship: 'Target', priority: 'High', location: 'Madrid', why: 'Big buyer', people_ids: ['p1', 'p2'] });
    const since = (await (await call(`/companies/list?since=${encodeURIComponent('2026-06-01T00:00:00.000Z')}`)).json()) as any;
    expect(since.companies.map((c: any) => c.name)).toEqual(['Acme Inc']);
  });

  it('creates a company, but returns an existing one with the same name (ignoring Inc., Ltd)', async () => {
    const res = await call('/companies/create', { name: ' Globex GmbH ', website: 'globex.com', industry: 'Software', relationship: 'Prospect' });
    const made = (await res.json()) as any;
    expect(made.existed).toBe(false);
    expect(made.company).toMatchObject({ name: 'Globex GmbH', website: 'https://globex.com', industry: 'Software', relationship: 'Prospect' });
    const again = (await (await call('/companies/create', { name: 'Globex' })).json()) as any;
    expect(again.existed).toBe(true);
    expect(again.company.id).toBe(made.company.id);
    expect(notion.rows.filter((r) => r.db === 'companies-db')).toHaveLength(1);
  });

  it('edits and clears fields, and explains bad values', async () => {
    const c = company('Acme', { Industry: { select: { name: 'Fintech' } }, Website: { url: 'https://acme.com' } });
    const ok = (await (await call('/companies/update', { id: c.id, name: 'Acme Corp', relationship: 'Active', priority: 'Medium', industry: '', website: '', location: 'Berlin', notes: 'Met the CEO', linkedin: 'linkedin.com/company/acme' })).json()) as any;
    expect(ok.company).toMatchObject({ name: 'Acme Corp', relationship: 'Active', priority: 'Medium', industry: '', website: '', location: 'Berlin', notes: 'Met the CEO', linkedin: 'https://linkedin.com/company/acme' });
    const msg = async (b: unknown) => ((await (await call('/companies/update', b)).json()) as any).error as string;
    expect(await msg({ id: c.id, website: 'not a site' })).toMatch(/website/);
    expect(await msg({ id: c.id, industry: 'Pottery' })).toMatch(/industry/);
    expect(await msg({ id: c.id, name: ' ' })).toMatch(/name/);
    expect(await msg({ id: c.id })).toMatch(/Nothing/);
    expect(((await (await call('/companies/create', {})).json()) as any).error).toMatch(/name/);
  });

  it('only touches rows of the Companies database', async () => {
    const person = notion.seed('people-db', { Name: title('Somebody') });
    expect((await call('/companies/update', { id: person.id, name: 'hacked' })).status).toBe(404);
    expect((await call(`/companies/history?id=${person.id}`)).status).toBe(404);
  });

  it('history: direct company links and those of its people, from meetings and interactions', async () => {
    const ann = notion.seed('people-db', { Name: title('Ann') });
    const c = company('Acme', { People: { relation: [{ id: ann.id }] } });
    notion.seed('interactions-db', { Title: title('Call with Ann'), Date: { date: { start: '2026-10-20' } }, People: { relation: [{ id: ann.id }] } });
    notion.seed('interactions-db', { Title: title('Sent proposal to Acme'), Date: { date: { start: '2026-10-25' } }, 'Companies (direct)': { relation: [{ id: c.id }] } });
    notion.seed('meetings-db', { Name: title('Quarterly review'), Date: { date: { start: '2026-09-01' } }, Attendees: { relation: [{ id: ann.id }] } });
    notion.seed('interactions-db', { Title: title('Unrelated'), Date: { date: { start: '2026-10-26' } }, People: { relation: [{ id: 'other' }] } });
    const { history } = (await (await call(`/companies/history?id=${c.id}`)).json()) as any;
    expect(history.map((h: any) => h.title)).toEqual(['Sent proposal to Acme', 'Call with Ann', 'Quarterly review']);
  });
});

describe('logging a meeting or interaction', () => {
  const authed = { Authorization: 'Bearer correct horse' };
  let notion: FakeNotion;
  const lEnv = { ...env, NOTION_PEOPLE_DB: 'people-db', NOTION_INTERACTIONS_DB: 'interactions-db', NOTION_MEETINGS_DB: 'meetings-db' };
  const call = (body: unknown, token = true) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    return worker
      .fetch(new Request('https://w.test/interactions/create', { method: 'POST', headers: token ? authed : {}, body: JSON.stringify(body) }), lEnv)
      .finally(() => (globalThis.fetch = realFetch));
  };
  const person = (name: string) => notion.seed('people-db', { Name: title(name) });
  beforeEach(() => { notion = new FakeNotion(); });

  it('needs the access token', async () => {
    expect((await call({}, false)).status).toBe(401);
  });

  it('logs an interaction with type, date, direction, summary and the follow-up flag, titled after the person', async () => {
    const ann = person('Ann Adams');
    const res = await call({ type: 'Call', person_ids: [ann.id], date: '2026-10-28', direction: 'Outbound', summary: 'Wants a demo', needs_followup: true });
    expect(res.status).toBe(200);
    const { logged } = (await res.json()) as any;
    expect(logged).toMatchObject({ kind: 'interaction', title: 'Call with Ann Adams', type: 'Call', date: '2026-10-28' });
    const row = notion.rows.find((r) => r.db === 'interactions-db')!;
    expect(row.properties.Type.select.name).toBe('Call');
    expect(row.properties.Direction.select.name).toBe('Outbound');
    expect(row.properties['Needs follow-up'].checkbox).toBe(true);
    expect(row.properties.Summary.rich_text[0].text.content).toBe('Wants a demo');
    expect(row.properties.People.relation).toEqual([{ id: ann.id }]);
  });

  it('logs a calendar meeting in the Meetings database with attendees and topics', async () => {
    const a = person('Ann Adams');
    const b = person('Bob Brown');
    const { logged } = (await (await call({ type: 'Meeting', person_ids: [a.id, b.id], date: '2026-10-28', summary: 'Pricing', title: 'Budget review' })).json()) as any;
    expect(logged).toMatchObject({ kind: 'meeting', title: 'Budget review' });
    const row = notion.rows.find((r) => r.db === 'meetings-db')!;
    expect(row.properties.Attendees.relation).toEqual([{ id: a.id }, { id: b.id }]);
    expect(row.properties['Topics Discussed'].rich_text[0].text.content).toBe('Pricing');
    expect(notion.rows.filter((r) => r.db === 'interactions-db')).toHaveLength(0);
  });

  it('is safe to send twice and defaults the date to today', async () => {
    const ann = person('Ann Adams');
    const first = (await (await call({ type: 'In person', person_ids: [ann.id], date: '2026-10-28' })).json()) as any;
    const second = (await (await call({ type: 'In person', person_ids: [ann.id], date: '2026-10-28' })).json()) as any;
    expect(second.logged.id).toBe(first.logged.id);
    expect(notion.rows.filter((r) => r.db === 'interactions-db')).toHaveLength(1);
    const today = (await (await call({ type: 'Email', person_ids: [ann.id], today: '2026-11-01' })).json()) as any;
    expect(today.logged.date).toBe('2026-11-01');
  });

  it('refuses bad input and pages that are not people', async () => {
    const ann = person('Ann Adams');
    const company = notion.seed('companies-db', { Name: title('Acme') });
    const msg = async (b: unknown) => ((await (await call(b)).json()) as any).error as string;
    expect(await msg({ type: 'Dance', person_ids: [ann.id] })).toMatch(/Type must be/);
    expect(await msg({ type: 'Call', person_ids: [] })).toMatch(/at least one person/);
    expect(await msg({ type: 'Call', person_ids: ['../x'] })).toMatch(/at least one person/);
    expect(await msg({ type: 'Call', person_ids: [ann.id], date: 'yesterday' })).toMatch(/date/);
    expect(await msg({ type: 'Call', person_ids: [ann.id], direction: 'Sideways' })).toMatch(/Direction/);
    expect((await call({ type: 'Call', person_ids: [company.id] })).status).toBe(404);
    expect(notion.rows.filter((r) => r.db === 'interactions-db')).toHaveLength(0);
  });
});
