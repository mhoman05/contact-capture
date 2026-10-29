import { describe, expect, it } from 'vitest';
import { lastContact, toPerson } from '../src/people';
import type { NotionPage } from '../src/notion';

const NOW = new Date('2026-10-29T10:00:00Z');
const page = (properties: Record<string, any>): NotionPage => ({ id: 'p1', url: 'u', properties, created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-10-01T00:00:00Z' } as NotionPage);
const rollup = (d: string) => ({ rollup: { type: 'date', date: { start: d } } });
const formula = (d: string) => ({ formula: { type: 'date', date: { start: d } } });
const events = new Map([['e1', '2026-10-26'], ['e2', '2026-11-20']]);

describe('last contact', () => {
  it('takes the latest of meetings, interactions and events', () => {
    const p = page({ 'Latest Meeting': rollup('2026-09-15'), 'Latest Interaction': rollup('2026-10-22'), Events: { relation: [{ id: 'e1' }] } });
    expect(lastContact(p, events, NOW)).toBe('2026-10-26'); // the event is the most recent
    expect(lastContact(page({ 'Latest Meeting': rollup('2026-09-15'), 'Latest Interaction': rollup('2026-10-22') }), events, NOW)).toBe('2026-10-22');
  });
  it('reads the Last Contacted formula too, whatever shape it has', () => {
    expect(lastContact(page({ 'Last Contacted': formula('2026-08-01T10:00:00.000+02:00') }), events, NOW)).toBe('2026-08-01');
    expect(lastContact(page({ 'Last Contacted': { formula: { type: 'string', string: '2026-07-04' } } }), events, NOW)).toBe('2026-07-04');
    expect(lastContact(page({ 'Last Contacted': { formula: { type: 'number', number: 12 } } }), events, NOW)).toBe('');
  });
  it('ignores planned meetings and future events, but allows today in any time zone', () => {
    expect(lastContact(page({ 'Latest Meeting': rollup('2026-11-03'), 'Latest Interaction': rollup('2026-10-10'), Events: { relation: [{ id: 'e2' }] } }), events, NOW)).toBe('2026-10-10');
    expect(lastContact(page({ 'Latest Meeting': rollup('2026-10-30') }), events, NOW)).toBe('2026-10-30'); // tomorrow in UTC can still be "today" locally
  });
  it('is empty when nothing is known', () => {
    expect(lastContact(page({}), events, NOW)).toBe('');
    expect(toPerson(page({ Name: { title: [] } }), new Map(), new Map()).last_contact).toBe('');
  });
});
