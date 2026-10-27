import type { NotionClient, NotionPage } from './notion';
import { P, plain } from './notion';
import { nonEmpty } from './normalize';

/** One row of the Events database. */
export interface EventItem {
  id: string;
  name: string;
  date: string; // YYYY-MM-DD of the start, or ''
  location: string;
  type: string;
}

export const EVENT_TYPES = ['Conference', 'Dinner / Drinks', 'Meetup', 'Panel / Speaking', 'Other'];

export function toEvent(page: NotionPage): EventItem {
  const p = page.properties;
  return {
    id: page.id,
    name: plain(p['Name']).trim(),
    date: (p['Date']?.date?.start ?? '').slice(0, 10),
    location: plain(p['Location']).trim(),
    type: p['Type']?.select?.name ?? '',
  };
}

/** Newest first, so the event you are at today is near the top. The app re-sorts by distance from today. */
export async function listEvents(notion: NotionClient, dbId: string): Promise<EventItem[]> {
  const rows = await notion.queryAll(dbId, 300);
  return rows
    .map(toEvent)
    .filter((e) => e.name)
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

export interface NewEvent {
  name: string;
  date: string;
  location: string;
  type: string;
}

export function parseNewEvent(raw: unknown, today: string): NewEvent | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' ? nonEmpty(o.name, 150) : null;
  if (!name) return 'Give the event a name.';
  const date = typeof o.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.date) ? o.date : today;
  const location = typeof o.location === 'string' ? (nonEmpty(o.location, 150) ?? '') : '';
  const type = typeof o.type === 'string' && EVENT_TYPES.includes(o.type) ? o.type : 'Other';
  return { name, date, location, type };
}

export async function createEvent(notion: NotionClient, dbId: string, e: NewEvent): Promise<EventItem> {
  const props: Record<string, unknown> = { Name: P.title(e.name), Date: P.date(e.date), Type: P.select(e.type) };
  if (e.location) props.Location = P.rich(e.location);
  return toEvent(await notion.createPage(dbId, props));
}

const dashless = (id: string) => id.replace(/-/g, '').toLowerCase();

/** An existing event by id. Refuses any page that is not a row of the Events database. */
export async function getEvent(notion: NotionClient, dbId: string, pageId: string): Promise<EventItem | null> {
  const page = await notion.getPage(pageId);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(dbId)) return null;
  return toEvent(page);
}
