import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { toMeeting } from '../src/meetings';
import type { Env } from '../src/types';
import { FakeNotion, rich, title } from './fake-notion';

const env: Env = {
  ANTHROPIC_API_KEY: 'k', NOTION_TOKEN: 's', CAPTURE_TOKEN: 'correct horse',
  NOTION_PEOPLE_DB: 'people-db', NOTION_COMPANIES_DB: 'companies-db', NOTION_INTERACTIONS_DB: 'i', NOTION_MEETINGS_DB: 'meetings-db',
};
const authed = { Authorization: 'Bearer correct horse' };
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

function setup() {
  const notion = new FakeNotion();
  const call = async (path: string, init: RequestInit = {}, e: Env = env) => {
    const real = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    try { return await worker.fetch(new Request(`https://w.test${path}`, { headers: authed, ...init }), e); } finally { globalThis.fetch = real; }
  };
  return { notion, call };
}

describe('toMeeting', () => {
  it('reads the date (with or without a time), type, attendees, companies and topics', () => {
    const m = toMeeting({ id: 'm1', url: 'u', properties: { Name: title('Coffee'), Date: { date: { start: '2026-10-28T09:00:00.000+01:00', end: null } }, Type: { select: { name: 'Personal' } }, Attendees: { relation: [{ id: 'p1' }] }, 'Companies (direct)': { relation: [{ id: 'c1' }] }, 'Topics Discussed': rich('Pricing') } } as any);
    expect(m).toMatchObject({ id: 'm1', title: 'Coffee', type: 'Personal', start: '2026-10-28T09:00:00.000+01:00', all_day: false, attendee_ids: ['p1'], company_ids: ['c1'], topics: 'Pricing' });
    expect(toMeeting({ id: 'm2', url: 'u', properties: { Name: title(''), Date: { date: { start: '2026-10-28' } } } } as any)).toMatchObject({ title: 'Meeting', all_day: true, attendee_ids: [] });
  });
});

describe('GET /meetings/upcoming', () => {
  it('needs the access token', async () => {
    const { call } = setup();
    expect((await call('/meetings/upcoming', { headers: {} })).status).toBe(401);
  });
  it('lists meetings from yesterday to a week ahead, soonest first, and leaves out the rest', async () => {
    const { notion, call } = setup();
    const m = (name: string, d: string, extra: object = {}) => notion.seed('meetings-db', { Name: title(name), Date: { date: { start: d } }, ...extra });
    m('Later today', `${day(0)}T15:00:00.000+01:00`, { Attendees: { relation: [{ id: 'p1' }] } });
    m('Tomorrow', `${day(1)}T11:30:00.000+01:00`);
    m('Long ago', day(-20));
    m('Far ahead', day(30));
    notion.seed('meetings-db', { Name: title('No date') });
    const res = (await (await call('/meetings/upcoming')).json()) as any;
    expect(res.meetings.map((x: any) => x.title)).toEqual(['Later today', 'Tomorrow']);
    expect(res.meetings[0].attendee_ids).toEqual(['p1']);
  });
  it('takes an explicit window and rejects bad dates', async () => {
    const { notion, call } = setup();
    notion.seed('meetings-db', { Name: title('Old one'), Date: { date: { start: '2026-01-10' } } });
    const ok = (await (await call('/meetings/upcoming?from=2026-01-01&to=2026-01-31')).json()) as any;
    expect(ok.meetings.map((x: any) => x.title)).toEqual(['Old one']);
    expect((await call('/meetings/upcoming?from=yesterday')).status).toBe(400);
  });
  it('says so when no Meetings database is configured', async () => {
    const { call } = setup();
    expect((await call('/meetings/upcoming', {}, { ...env, NOTION_MEETINGS_DB: undefined })).status).toBe(503);
  });
});

describe('POST /meetings/notes', () => {
  const post = (call: any, body: unknown) => call('/meetings/notes', { method: 'POST', body: JSON.stringify(body) });
  it('appends a dated line to Topics Discussed, once', async () => {
    const { notion, call } = setup();
    const row = notion.seed('meetings-db', { Name: title('Coffee'), Date: { date: { start: day(0) } }, 'Topics Discussed': rich('Pricing') });
    const first = (await (await post(call, { id: row.id, note: 'Agreed a demo next week', today: '2026-10-31' })).json()) as any;
    expect(first.meeting.topics).toBe('Pricing\n2026-10-31: Agreed a demo next week');
    const again = (await (await post(call, { id: row.id, note: 'Agreed a demo next week', today: '2026-10-31' })).json()) as any;
    expect(again.meeting.topics).toBe('Pricing\n2026-10-31: Agreed a demo next week');
  });
  it('refuses pages from other databases and bad requests', async () => {
    const { notion, call } = setup();
    const other = notion.seed('people-db', { Name: title('Not a meeting') });
    expect((await post(call, { id: other.id, note: 'x' })).status).toBe(404);
    expect((await post(call, { id: other.id, note: '  ' })).status).toBe(400);
    expect((await post(call, { note: 'x' })).status).toBe(400);
  });
});
