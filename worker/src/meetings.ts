// The "Next meetings" card and briefing: meetings of the Notion Meetings database in a date window, and notes added after a meeting.
import { P, plain, type NotionClient, type NotionPage } from './notion';
import { pageTitle } from './notion';
import { truncate } from './normalize';

const dashless = (s: string) => s.replace(/-/g, '');

export interface MeetingItem {
  id: string;
  url: string;
  title: string;
  type: string; // Internal, External, Personal or ''
  start: string; // ISO date or date-time as Notion has it, '' when the meeting has no date
  end: string;
  all_day: boolean;
  attendee_ids: string[];
  company_ids: string[];
  topics: string;
}

export function toMeeting(page: NotionPage): MeetingItem {
  const p = page.properties;
  const start: string = p.Date?.date?.start ?? '';
  return {
    id: page.id,
    url: page.url,
    title: pageTitle(page, 'Name') || 'Meeting',
    type: p.Type?.select?.name ?? '',
    start,
    end: p.Date?.date?.end ?? '',
    all_day: !!start && !start.includes('T'),
    attendee_ids: (p.Attendees?.relation ?? []).map((r: any) => r.id as string),
    company_ids: (p['Companies (direct)']?.relation ?? []).map((r: any) => r.id as string),
    topics: plain(p['Topics Discussed']).trim(),
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: unknown): s is string => typeof s === 'string' && DAY.test(s);

/** Meetings dated from `from` to `to` (YYYY-MM-DD, inclusive), soonest first. */
export async function listMeetings(notion: NotionClient, db: string, from: string, to: string): Promise<MeetingItem[]> {
  const rows = await notion.query(db, { and: [{ property: 'Date', date: { on_or_after: from } }, { property: 'Date', date: { on_or_before: to } }] }, 60);
  return rows.map(toMeeting).filter((m) => m.start).sort((a, b) => a.start.localeCompare(b.start));
}

/** Appends a dated line to "Topics Discussed" (a repeated request adds nothing). Null when the page is not in the Meetings database. */
export async function addMeetingNotes(notion: NotionClient, db: string, id: string, note: string, today: string): Promise<MeetingItem | null> {
  const page = await notion.getPage(id);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(db)) return null;
  const current = plain(page.properties['Topics Discussed']).trim();
  const line = `${today}: ${note}`;
  if (current.split('\n').includes(line)) return toMeeting(page);
  const updated = await notion.updatePage(id, { 'Topics Discussed': P.rich(truncate(current ? `${current}\n${line}` : line, 1900)) });
  return toMeeting(updated);
}
