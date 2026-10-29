import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';
import { FakeNotion, rich, title } from './fake-notion';

const env: Env = {
  ANTHROPIC_API_KEY: 'k', NOTION_TOKEN: 's', CAPTURE_TOKEN: 'correct horse',
  NOTION_PEOPLE_DB: 'people-db', NOTION_COMPANIES_DB: 'companies-db', NOTION_INTERACTIONS_DB: 'interactions-db', NOTION_MEETINGS_DB: 'meetings-db', NOTION_TASKS_DB: 'tasks-db',
};
const authed = { Authorization: 'Bearer correct horse' };

function setup() {
  const notion = new FakeNotion();
  const call = async (path: string, e: Env = env, headers: Record<string, string> = authed) => {
    const real = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    try { return await worker.fetch(new Request(`https://w.test${path}`, { headers }), e); } finally { globalThis.fetch = real; }
  };
  return { notion, call };
}

describe('backup export', () => {
  it('needs the access token', async () => {
    const { call } = setup();
    expect((await call('/export/interactions', env, {})).status).toBe(401);
    expect((await call('/export/meetings', env, {})).status).toBe(401);
  });
  it('pages through every interaction with its people, 100 at a time', async () => {
    const { notion, call } = setup();
    for (let i = 0; i < 130; i++) notion.seed('interactions-db', { Title: title(`Call ${i}`), Type: { select: { name: 'Call' } }, Direction: { select: { name: 'Outbound' } }, Date: { date: { start: '2026-10-01' } }, Summary: rich('Talked'), People: { relation: [{ id: 'p-1' }] }, 'Needs follow-up': { checkbox: i === 0 } });
    const first = (await (await call('/export/interactions')).json()) as any;
    expect(first.rows).toHaveLength(100);
    expect(first.next_cursor).toBeTruthy();
    expect(first.rows[0]).toMatchObject({ title: 'Call 0', type: 'Call', direction: 'Outbound', date: '2026-10-01', summary: 'Talked', person_ids: ['p-1'], needs_followup: true });
    const second = (await (await call(`/export/interactions?cursor=${encodeURIComponent(first.next_cursor)}`)).json()) as any;
    expect(second.rows).toHaveLength(30);
    expect(second.next_cursor).toBeNull();
  });
  it('exports meetings with attendees and topics, and an empty list without a Meetings database', async () => {
    const { notion, call } = setup();
    notion.seed('meetings-db', { Name: title('Coffee with Ann'), Type: { select: { name: 'External' } }, Date: { date: { start: '2026-10-20' } }, Attendees: { relation: [{ id: 'p-1' }] }, 'Topics Discussed': rich('Pricing') });
    const res = (await (await call('/export/meetings')).json()) as any;
    expect(res.rows[0]).toMatchObject({ title: 'Coffee with Ann', type: 'External', date: '2026-10-20', topics: 'Pricing', person_ids: ['p-1'] });
    const none = (await (await call('/export/meetings', { ...env, NOTION_MEETINGS_DB: undefined })).json()) as any;
    expect(none).toEqual({ rows: [], next_cursor: null });
  });
  it('lists every task, including old finished ones, when asked for all', async () => {
    const { notion, call } = setup();
    notion.seed('tasks-db', { Name: title('Open'), Status: { status: { name: 'Not started' } } });
    const old = notion.seed('tasks-db', { Name: title('Done long ago'), Status: { status: { name: 'Done' } } });
    old.edited = '2025-01-01T00:00:00.000Z';
    const normal = ((await (await call('/tasks/list')).json()) as any).tasks.map((t: any) => t.title);
    expect(normal).toEqual(['Open']);
    const all = ((await (await call('/tasks/list?all=1')).json()) as any).tasks.map((t: any) => t.title).sort();
    expect(all).toEqual(['Done long ago', 'Open']);
  });
});
