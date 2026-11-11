import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { parseSave } from '../src/backup';
import type { Env } from '../src/types';
import { FakeNotion } from './fake-notion';

const env: Env = { ANTHROPIC_API_KEY: 'k', NOTION_TOKEN: 's', CAPTURE_TOKEN: 'correct horse', NOTION_PEOPLE_DB: 'p', NOTION_COMPANIES_DB: 'c', NOTION_INTERACTIONS_DB: 'i', NOTION_BACKUPS_DB: 'backups-db' };
const authed = { Authorization: 'Bearer correct horse', Origin: 'https://mydayappmh.github.io' };

function setup() {
  const notion = new FakeNotion();
  const call = async (path: string, init: RequestInit = {}, e: Env = env) => {
    const real = globalThis.fetch;
    globalThis.fetch = ((i: any, n: any) => notion.fetch(i, n)) as typeof fetch;
    try { return await worker.fetch(new Request(`https://w.test${path}`, init), e); } finally { globalThis.fetch = real; }
  };
  const save = (app: string, data: string, headers: Record<string, string> = authed) => call('/backup/save', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ app, data, device: 'Pixel 8' }) });
  return { notion, call, save };
}
const b64 = (n: number) => 'gz:' + 'QUJD'.repeat(n);

describe('shared backup', () => {
  it('needs the access token, also for the browser preflight answer', async () => {
    const { call, save } = setup();
    expect((await save('myday', b64(2), {})).status).toBe(401);
    expect((await call('/backup/list')).status).toBe(401);
    const pre = await call('/backup/save', { method: 'OPTIONS', headers: { Origin: 'https://mydayappmh.github.io' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://mydayappmh.github.io');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });
  it('allows only the two app origins', async () => {
    const { call } = setup();
    expect((await call('/backup/list', { headers: { ...authed, Origin: 'https://matthias-sport.github.io' } })).headers.get('Access-Control-Allow-Origin')).toBe('https://matthias-sport.github.io');
    expect((await call('/backup/list', { headers: { ...authed, Origin: 'https://evil.example' } })).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
  it('saves and loads a backup exactly, also across many Notion pieces and blocks', async () => {
    const { save, call, notion } = setup();
    const data = 'gz:' + Array.from({ length: 300_000 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[(i * 7) % 64]).join('');
    const res = await save('myday', data);
    expect(res.status).toBe(200);
    const saved = (await res.json()) as any;
    expect(saved.backup).toMatchObject({ app: 'myday', name: 'My Day', device: 'Pixel 8', size_kb: 300 });
    const row = notion.rows[0];
    expect(row.children!.filter((b: any) => b.type === 'code')).toHaveLength(2); // 150 pieces of 2000 characters, at most 100 per block
    const loaded = (await (await call('/backup/load?app=myday', { headers: authed })).json()) as any;
    expect(loaded.data).toBe(data);
    expect(loaded.device).toBe('Pixel 8');
  });
  it('returns the newest backup and keeps only the last three of each app', async () => {
    const { save, call, notion } = setup();
    for (const n of [1, 2, 3, 4, 5]) await save('rankings', b64(n));
    await save('myday', b64(9));
    const loaded = (await (await call('/backup/load?app=rankings', { headers: authed })).json()) as any;
    expect(loaded.data).toBe(b64(5));
    expect(notion.rows.filter((r) => !r.archived && r.properties.App.title[0].text.content === 'Racket Rankings')).toHaveLength(3);
    const list = (await (await call('/backup/list', { headers: authed })).json()) as any;
    expect(list.backups.map((b: any) => b.app)).toEqual(['myday', 'rankings']);
    expect(list.backups.every((b: any) => /^\d{4}-/.test(b.at))).toBe(true);
  });
  it('says so when there is no backup yet, and rejects an unknown app', async () => {
    const { call } = setup();
    expect((await call('/backup/load?app=crm', { headers: authed })).status).toBe(404);
    expect((await call('/backup/load?app=nope', { headers: authed })).status).toBe(400);
  });
  it('rejects data that is not base64 or too large, and an unknown app', async () => {
    expect(parseSave({ app: 'myday', data: '<script>' })).toMatch(/base64/);
    expect(parseSave({ app: 'x', data: 'gz:QUJD' })).toMatch(/app must/);
    expect(parseSave({ app: 'myday', data: 'raw:' + 'A'.repeat(400_001) })).toMatch(/too large/);
    expect(parseSave({ app: 'crm', data: 'gz:QUJD', device: 'a<b>' })).toEqual({ app: 'crm', data: 'gz:QUJD', device: 'ab' });
  });
  it('uses the right methods', async () => {
    const { call } = setup();
    expect((await call('/backup/save', { headers: authed })).status).toBe(405);
    expect((await call('/backup/list', { method: 'POST', headers: authed })).status).toBe(405);
  });
  it('says clearly when the Notion database is not configured', async () => {
    const { call } = setup();
    expect((await call('/backup/list', { headers: authed }, { ...env, NOTION_BACKUPS_DB: undefined })).status).toBe(503);
  });
});
