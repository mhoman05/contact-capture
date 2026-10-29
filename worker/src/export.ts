// Pages of the Interactions and Meetings databases for the backup (the app already pages People, Companies and Tasks).
import { plain, pageTitle, type NotionClient, type NotionPage } from './notion';

const ids = (p: NotionPage, prop: string): string[] => (p.properties[prop]?.relation ?? []).map((r: any) => r.id as string);
const day = (p: NotionPage) => (p.properties.Date?.date?.start ?? '').slice(0, 10);

export interface ExportInteraction {
  id: string;
  url: string;
  title: string;
  type: string;
  direction: string;
  date: string;
  summary: string;
  needs_followup: boolean;
  person_ids: string[];
  company_ids: string[];
  created: string;
}

export interface ExportMeeting {
  id: string;
  url: string;
  title: string;
  type: string;
  date: string;
  topics: string;
  person_ids: string[];
  company_ids: string[];
  created: string;
}

async function page(notion: NotionClient, db: string, cursor?: string) {
  const res = await notion.queryPage(db, {
    page_size: 100,
    sorts: [{ timestamp: 'created_time', direction: 'ascending' }], // a stable order, so paging is not shuffled by edits
    ...(cursor ? { start_cursor: cursor } : {}),
  });
  return { results: res.results, next_cursor: res.has_more ? res.next_cursor : null };
}

export async function exportInteractions(notion: NotionClient, db: string, cursor?: string): Promise<{ rows: ExportInteraction[]; next_cursor: string | null }> {
  const { results, next_cursor } = await page(notion, db, cursor);
  return {
    next_cursor,
    rows: results.map((m) => ({
      id: m.id,
      url: m.url,
      title: pageTitle(m, 'Title'),
      type: m.properties.Type?.select?.name ?? '',
      direction: m.properties.Direction?.select?.name ?? '',
      date: day(m),
      summary: plain(m.properties.Summary).trim(),
      needs_followup: !!m.properties['Needs follow-up']?.checkbox,
      person_ids: ids(m, 'People'),
      company_ids: ids(m, 'Companies (direct)'),
      created: m.created_time ?? '',
    })),
  };
}

export async function exportMeetings(notion: NotionClient, db: string, cursor?: string): Promise<{ rows: ExportMeeting[]; next_cursor: string | null }> {
  const { results, next_cursor } = await page(notion, db, cursor);
  return {
    next_cursor,
    rows: results.map((m) => ({
      id: m.id,
      url: m.url,
      title: pageTitle(m, 'Name'),
      type: m.properties.Type?.select?.name ?? '',
      date: day(m),
      topics: plain(m.properties['Topics Discussed']).trim(),
      person_ids: ids(m, 'Attendees'),
      company_ids: ids(m, 'Companies (direct)'),
      created: m.created_time ?? '',
    })),
  };
}
