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

describe('the other Notion fields of a person', () => {
  const companies = new Map([['c1', 'Acme'], ['c2', 'Globex']]);
  const evs = new Map([['e1', 'MERGE Madrid'], ['e2', 'Dinner']]);
  const dates = new Map([['e1', '2026-10-26'], ['e2', '2026-09-01']]);
  const page = (properties: Record<string, any>) => ({ id: 'p1', url: 'u', properties, created_time: '2026-01-01T00:00:00Z', last_edited_time: '2026-10-01T00:00:00Z' }) as any;
  it('reads selects, texts, dates, relations, formulas and rollups', () => {
    const p = toPerson(page({
      Name: { title: [{ plain_text: 'Ann' }] },
      'Target Status': { select: { name: 'Meeting booked' } }, 'Target Priority': { select: { name: 'High' } },
      'Why They Matter': { rich_text: [{ plain_text: 'Runs sales' }] },
      Birthday: { date: { start: '1980-05-17' } }, 'Last Enriched': { date: { start: '2026-09-10' } },
      'Previous Companies': { relation: [{ id: 'c2' }, { id: 'gone' }] }, 'Can Introduce (Companies)': { relation: [{ id: 'c1' }] },
      'Potential Intro': { relation: [{ id: 'x1' }] }, 'Introduced By': { relation: [{ id: 'x2' }] }, Introduced: { relation: [{ id: 'x3' }, { id: 'x4' }] }, 'Can Introduce': { relation: [] },
      'Follow-up Status': { formula: { type: 'string', string: 'Overdue' } }, 'Next Contact Due': { formula: { type: 'date', date: { start: '2026-11-01' } } },
      'Cadence (days)': { formula: { type: 'number', number: 30 } }, 'Open Task Count': { formula: { type: 'number', number: 2 } }, '# Meetings': { formula: { type: 'number', number: 0 } },
      'Needs Enrichment': { formula: { type: 'boolean', boolean: true } }, Review: { formula: { type: 'string', string: 'Target' } },
      'Relationship summary': { rich_text: [{ plain_text: 'Sales director at Acme. Last spoke 22 Oct.' }] },
      Events: { relation: [{ id: 'e1' }, { id: 'nope' }, { id: 'e2' }] },
    }), companies, evs, dates);
    expect(p).toMatchObject({
      target_status: 'Meeting booked', target_priority: 'High', why: 'Runs sales', birthday: '1980-05-17', last_enriched: '2026-09-10',
      previous_companies: ['Globex'], can_introduce_companies: ['Acme'], potential_intro_ids: ['x1'], introduced_by_ids: ['x2'], introduced_ids: ['x3', 'x4'], can_introduce_ids: [],
      follow_up_status: 'Overdue', next_contact_due: '2026-11-01', cadence: '30', open_tasks: '2', meetings_count: '0', needs_enrichment: 'Yes', review: 'Target',
      summary: 'Sales director at Acme. Last spoke 22 Oct.', events: ['MERGE Madrid', 'Dinner'], event_dates: ['2026-10-26', '2026-09-01'],
    });
  });
  it('prefers the History summary over the Notion AI Relationship summary', () => {
    const rt = (t: string) => ({ rich_text: [{ plain_text: t }] });
    expect(toPerson(page({ Name: { title: [] }, 'History summary': rt('From the history'), 'Relationship summary': rt('From Notion AI') }), companies, evs, dates).summary).toBe('From the history');
    expect(toPerson(page({ Name: { title: [] }, 'History summary': rt(''), 'Relationship summary': rt('From Notion AI') }), companies, evs, dates).summary).toBe('From Notion AI');
  });
  it('is empty, not broken, when properties are missing or in an unexpected shape', () => {
    const p = toPerson(page({ Name: { title: [] }, 'Relationship summary': { type: 'unsupported', unsupported: {} }, 'Next Contact Due': { formula: { type: 'unknown' } } }), companies, evs, dates);
    expect(p).toMatchObject({ summary: '', target_status: '', birthday: '', previous_companies: [], follow_up_status: '', next_contact_due: '', events: [], event_dates: [] });
  });
});
