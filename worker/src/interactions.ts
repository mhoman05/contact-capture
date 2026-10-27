import { nonEmpty, truncate } from './normalize';
import { P, type NotionClient, type NotionPage } from './notion';

export const INTERACTION_TYPES = ['Call', 'Online call', 'In person', 'WhatsApp / Message', 'Email', 'LinkedIn', 'Event'];
export const DIRECTIONS = ['Outbound', 'Inbound'];
/** "Meeting" is logged in the Meetings database (the calendar log); everything else in Interactions. */
export const KINDS = [...INTERACTION_TYPES, 'Meeting'];

export interface LogInput {
  type: string; // one of KINDS
  person_ids: string[];
  date: string; // YYYY-MM-DD
  title: string; // '' = made from the type and the name
  summary: string;
  direction: string; // '' or Outbound / Inbound
  needs_followup: boolean;
}

export interface LogDeps {
  notion: NotionClient;
  interactionsDb: string;
  meetingsDb?: string;
}

export interface Logged {
  id: string;
  url: string;
  kind: 'interaction' | 'meeting';
  title: string;
  type: string;
  date: string;
}

const ID = /^[0-9a-z-]{6,40}$/i;

export function parseLog(raw: unknown, today: string): LogInput | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  const o = raw as Record<string, unknown>;
  if (typeof o.type !== 'string' || !KINDS.includes(o.type)) return `Type must be one of: ${KINDS.join(', ')}.`;
  const ids = o.person_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || !ids.every((x) => typeof x === 'string' && ID.test(x))) return 'Pick at least one person.';
  const date = o.date === undefined || o.date === '' ? today : o.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'The date must look like 2026-10-28.';
  const direction = typeof o.direction === 'string' ? o.direction : '';
  if (direction && !DIRECTIONS.includes(direction)) return 'Direction must be Outbound or Inbound.';
  return {
    type: o.type,
    person_ids: [...new Set(ids as string[])],
    date,
    title: typeof o.title === 'string' ? (nonEmpty(o.title, 150) ?? '') : '',
    summary: typeof o.summary === 'string' ? (nonEmpty(o.summary, 1900) ?? '') : '',
    direction,
    needs_followup: o.needs_followup === true,
  };
}

const startOf = (p: NotionPage, prop = 'Date') => (p.properties[prop]?.date?.start ?? '').slice(0, 10);
const people = (p: NotionPage, prop: string): string[] => (p.properties[prop]?.relation ?? []).map((r: any) => r.id);

/**
 * Log a meeting or an interaction with one or more people. Sending the same thing twice (a lost reply, a double tap)
 * returns the existing entry instead of creating a second one.
 */
export async function logInteraction(d: LogDeps, f: LogInput, names: string): Promise<Logged> {
  const meeting = f.type === 'Meeting';
  const title = f.title || (meeting ? `Meeting with ${names}` : f.type === 'Event' ? `Event with ${names}` : `${f.type} with ${names}`);
  const db = meeting ? d.meetingsDb : d.interactionsDb;
  if (!db) throw new Error(meeting ? 'The Meetings database is not configured.' : 'The Interactions database is not configured.');
  const titleProp = meeting ? 'Name' : 'Title';
  const peopleProp = meeting ? 'Attendees' : 'People';

  const same = await d.notion.query(db, { property: titleProp, title: { equals: title } }, 10);
  const existing = same.find((m) => startOf(m) === f.date && f.person_ids.every((id) => people(m, peopleProp).includes(id)));
  const page =
    existing ??
    (await d.notion.createPage(
      db,
      meeting
        ? {
            Name: P.title(title),
            Date: P.date(f.date),
            Type: P.select('External'),
            Attendees: P.relation(f.person_ids),
            ...(f.summary ? { 'Topics Discussed': P.rich(truncate(f.summary, 1900)) } : {}),
          }
        : {
            Title: P.title(title),
            Type: P.select(f.type),
            Date: P.date(f.date),
            People: P.relation(f.person_ids),
            'Needs follow-up': P.checkbox(f.needs_followup),
            ...(f.direction ? { Direction: P.select(f.direction) } : {}),
            ...(f.summary ? { Summary: P.rich(truncate(f.summary, 1900)) } : {}),
          },
    ));
  return { id: page.id, url: page.url, kind: meeting ? 'meeting' : 'interaction', title, type: f.type, date: f.date };
}
