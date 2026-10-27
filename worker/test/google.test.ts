import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { googleBody, parseGoogleContact, resetGoogleState } from '../src/google';
import type { Env } from '../src/types';

const env: Env = {
  ANTHROPIC_API_KEY: 'sk-test',
  NOTION_TOKEN: 'secret',
  CAPTURE_TOKEN: 'correct horse',
  NOTION_PEOPLE_DB: 'p',
  NOTION_COMPANIES_DB: 'c',
  NOTION_INTERACTIONS_DB: 'i',
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  GOOGLE_REFRESH_TOKEN: 'refresh',
};
const authed = { Authorization: 'Bearer correct horse' };

interface Sent { url: string; method: string; body: string }
let sent: Sent[];
let existing: any[]; // what Google's search returns as results
let tokenReply: { status: number; body: any };
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetGoogleState();
  sent = [];
  existing = [];
  tokenReply = { status: 200, body: { access_token: 'at', expires_in: 3600 } };
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    sent.push({ url, method: init.method ?? 'GET', body: String(init.body ?? '') });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return reply(tokenReply.status, tokenReply.body);
    if (url.includes('people:searchContacts')) return reply(200, { results: existing });
    if (url.includes('people:createContact')) return reply(200, { resourceName: 'people/c1' });
    return reply(404, {});
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const call = (body: unknown, e: Env = env, headers: Record<string, string> = authed) =>
  worker.fetch(new Request('https://w.test/contacts/google', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }), e);
const ann = { name: 'Ann Adams', company: 'Acme', role: 'CTO', phone: '+34 600 111 222', email: 'Ann@Acme.com', linkedin: 'https://linkedin.com/in/ann', note: 'Met at MERGE' };

describe('save to Google Contacts', () => {
  it('requires the access token', async () => {
    expect((await call(ann, env, {})).status).toBe(401);
    expect(sent).toEqual([]);
  });
  it('creates the contact with name, company, phone, email, links and note', async () => {
    const res = await call(ann);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'created' });
    const create = sent.find((s) => s.url.includes('createContact'))!;
    expect(create.method).toBe('POST');
    expect(JSON.parse(create.body)).toEqual({
      names: [{ givenName: 'Ann', familyName: 'Adams' }],
      organizations: [{ name: 'Acme', title: 'CTO' }],
      phoneNumbers: [{ value: '+34 600 111 222', type: 'mobile' }],
      emailAddresses: [{ value: 'Ann@Acme.com', type: 'work' }],
      urls: [{ value: 'https://linkedin.com/in/ann', type: 'profile' }],
      biographies: [{ value: 'Met at MERGE', contentType: 'TEXT_PLAIN' }],
    });
  });
  it('uses the refresh token to get an access token, and reuses it', async () => {
    await call(ann);
    await call({ ...ann, name: 'Bob Brown', email: 'bob@acme.com', phone: '+34 611 000 000' });
    const tokenCalls = sent.filter((s) => s.url.includes('oauth2.googleapis.com'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toContain('grant_type=refresh_token');
    expect(tokenCalls[0].body).toContain('refresh_token=refresh');
  });
  it('does not create a second contact when the email, phone or name is already there', async () => {
    existing = [{ person: { names: [{ displayName: 'Somebody Else' }], emailAddresses: [{ value: 'ann@acme.com' }] } }];
    expect(await (await call(ann)).json()).toEqual({ status: 'exists' });
    existing = [{ person: { names: [{ displayName: 'A. Adams' }], phoneNumbers: [{ value: '600111222' }] } }];
    expect(await (await call(ann)).json()).toEqual({ status: 'exists' });
    existing = [{ person: { names: [{ displayName: 'ann adams' }] } }];
    expect(await (await call({ name: 'Ann Adams' })).json()).toEqual({ status: 'exists' });
    expect(sent.some((s) => s.url.includes('createContact'))).toBe(false);
  });
  it('creates when the search finds only different people', async () => {
    existing = [{ person: { names: [{ displayName: 'Ann Other' }], emailAddresses: [{ value: 'other@x.com' }] } }];
    expect(await (await call(ann)).json()).toEqual({ status: 'created' });
  });
  it('says so when Google Contacts is not set up', async () => {
    const res = await call(ann, { ...env, GOOGLE_REFRESH_TOKEN: undefined });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toMatch(/not set up/);
    expect(sent).toEqual([]);
  });
  it('explains an expired permission', async () => {
    tokenReply = { status: 400, body: { error: 'invalid_grant' } };
    const res = await call(ann);
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toMatch(/GOOGLE_REFRESH_TOKEN/);
  });
  it('rejects bad requests', async () => {
    expect((await call('nope')).status).toBe(400);
    expect((await call({ name: '  ' })).status).toBe(400);
    expect((await call({ company: 'x' })).status).toBe(400);
  });
  it('parses and trims fields, and builds a one-word name', () => {
    expect(parseGoogleContact({ name: ' Pablo ', phone: 5 })).toMatchObject({ name: 'Pablo', phone: '' });
    expect(googleBody({ name: 'Pablo' })).toEqual({ names: [{ givenName: 'Pablo' }] });
    expect(googleBody({ name: 'Ana María de la Cruz' })).toEqual({ names: [{ givenName: 'Ana María de la', familyName: 'Cruz' }] });
  });
});
