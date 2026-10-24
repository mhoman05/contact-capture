import type { NotionClient, NotionPage } from './notion';
import { truncate } from './normalize';

/** One row of the "My sharing details" database. */
export interface MeItem {
  id: string;
  detail: string; // what the row is called, e.g. "Work phone"
  value: string; // what gets shared; empty rows are ignored by the app
  type: string; // First name, Last name, Company, Role, Phone, Email, Website, Address
  groups: string[]; // Personal, Professional, Indoor golf club, ...
  label: string; // optional label shown next to the detail in the other person's contacts
  order: number;
}

const plain = (prop: any): string => (prop?.rich_text ?? prop?.title ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join('');

export function toItem(page: NotionPage): MeItem {
  const p = page.properties;
  return {
    id: page.id,
    detail: plain(p['Detail']).trim(),
    value: plain(p['Value']).trim(),
    type: p['Type']?.select?.name ?? '',
    groups: (p['Type'] && p['Groups']?.multi_select ? p['Groups'].multi_select : []).map((g: any) => g.name as string),
    label: plain(p['Label']).trim(),
    order: typeof p['Order']?.number === 'number' ? p['Order'].number : 1000,
  };
}

export async function readMe(notion: NotionClient, dbId: string): Promise<MeItem[]> {
  const rows = await notion.queryAll(dbId, 200);
  return rows.map(toItem).sort((a, b) => a.order - b.order || a.detail.localeCompare(b.detail));
}

const dashless = (id: string) => id.replace(/-/g, '').toLowerCase();

/** Change the Value of one row. Refuses any page that is not a row of the "My sharing details" database. */
export async function updateMeValue(notion: NotionClient, dbId: string, pageId: string, value: string): Promise<MeItem | null> {
  const page = await notion.getPage(pageId);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(dbId)) return null;
  const updated = await notion.updatePage(pageId, { Value: { rich_text: value ? [{ type: 'text', text: { content: truncate(value, 1900) } }] : [] } });
  return toItem(updated);
}
