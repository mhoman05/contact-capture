import { listEvents } from './events';
import { cleanEmail, cleanLinkedInLink, cleanPhone, cleanTelegram, nonEmpty, truncate } from './normalize';
import { findOrCreateCompany, P, pageTitle, plain, type NotionClient, type NotionPage } from './notion';

/** What the app shows and edits for one person. */
export interface PersonItem {
  id: string;
  url: string;
  name: string;
  company: string;
  role: string;
  email: string;
  phone: string;
  linkedin: string;
  telegram: string;
  location: string;
  how: string; // How We Know Each Other
  notes: string;
  events: string[];
  needs_review: boolean;
  next_followup: string; // YYYY-MM-DD or ''
  created: string; // ISO time the person was added
}

export interface PeopleDeps {
  notion: NotionClient;
  peopleDb: string;
  companiesDb: string;
  eventsDb?: string;
}

export function toPerson(page: NotionPage, companies: Map<string, string>, events: Map<string, string>): PersonItem {
  const p = page.properties;
  return {
    id: page.id,
    url: page.url,
    name: pageTitle(page, 'Name'),
    company: (p.Company?.relation ?? []).map((r: any) => companies.get(r.id)).filter(Boolean).join(', '),
    role: plain(p.Role).trim(),
    email: p.Email?.email ?? '',
    phone: p.Phone?.phone_number ?? '',
    linkedin: p.LinkedIn?.url ?? '',
    telegram: p.Telegram?.url ?? '',
    location: plain(p.Location).trim(),
    how: plain(p['How We Know Each Other']).trim(),
    notes: plain(p.Notes).trim(),
    events: (p.Events?.relation ?? []).map((r: any) => events.get(r.id)).filter(Boolean) as string[],
    needs_review: !!p['Needs review']?.checkbox,
    next_followup: (p['Next Follow-up']?.date?.start ?? '').slice(0, 10),
    created: page.created_time ?? '',
  };
}

async function lookups(d: PeopleDeps) {
  const companies = new Map<string, string>();
  for (const c of await d.notion.queryAll(d.companiesDb, 1000)) companies.set(c.id, pageTitle(c, 'Name'));
  const events = new Map<string, string>();
  if (d.eventsDb) for (const e of await listEvents(d.notion, d.eventsDb)) events.set(e.id, e.name);
  return { companies, events };
}

/** The people most recently added to the CRM, newest first. */
export async function recentPeople(d: PeopleDeps, limit: number): Promise<PersonItem[]> {
  const { companies, events } = await lookups(d);
  const rows = await d.notion.recent(d.peopleDb, Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => toPerson(r, companies, events));
}

export interface PersonPatch {
  name?: string;
  company?: string;
  role?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  telegram?: string;
  location?: string;
  note?: string;
  needs_review?: boolean;
  next_followup?: string;
}

/** Validate an edit. Values that are given but unreadable are reported back instead of silently dropped; '' clears a field. */
export function parsePatch(raw: unknown): { id: string; patch: PersonPatch } | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[0-9a-z-]{6,40}$/i.test(o.id)) return 'Send the id of the person.';
  const patch: PersonPatch = {};
  const bad: string[] = [];
  const str = (k: string, max: number) => (typeof o[k] === 'string' ? (nonEmpty(o[k] as string, max) ?? '') : undefined);
  const cleaned = (k: keyof PersonPatch, label: string, max: number, clean: (s: string) => string | null) => {
    const v = str(k, max);
    if (v === undefined) return;
    if (v === '') (patch as Record<string, unknown>)[k] = '';
    else {
      const c = clean(v);
      if (c == null) bad.push(label);
      else (patch as Record<string, unknown>)[k] = c;
    }
  };
  const name = str('name', 120);
  if (name !== undefined) {
    if (!name) bad.push('name (it cannot be empty)');
    else patch.name = name;
  }
  for (const k of ['company', 'role', 'location'] as const) {
    const v = str(k, k === 'role' ? 150 : 120);
    if (v !== undefined) patch[k] = v;
  }
  cleaned('email', 'email address', 200, cleanEmail);
  cleaned('phone', 'phone number', 60, cleanPhone);
  cleaned('linkedin', 'LinkedIn link', 300, cleanLinkedInLink);
  cleaned('telegram', 'Telegram username', 100, cleanTelegram);
  const note = typeof o.note === 'string' ? nonEmpty(o.note, 1000) : null;
  if (note) patch.note = note;
  if (typeof o.needs_review === 'boolean') patch.needs_review = o.needs_review;
  if (typeof o.next_followup === 'string') {
    if (o.next_followup === '' || /^\d{4}-\d{2}-\d{2}$/.test(o.next_followup)) patch.next_followup = o.next_followup;
    else bad.push('follow-up date');
  }
  if (bad.length) return `Check the ${bad.join(', ')}: it could not be read.`;
  if (!Object.keys(patch).length) return 'Nothing to change.';
  return { id: o.id, patch };
}

const dashless = (id: string) => id.replace(/-/g, '').toLowerCase();

/** Apply an edit to one person. Refuses any page that is not a row of the People database. Returns null in that case. */
export async function updatePersonFields(d: PeopleDeps, id: string, patch: PersonPatch, today: string): Promise<PersonItem | null> {
  const page = await d.notion.getPage(id);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(d.peopleDb)) return null;
  const props: Record<string, unknown> = {};
  const text = (s: string) => (s ? P.rich(s) : { rich_text: [] });
  if (patch.name !== undefined) props.Name = P.title(patch.name);
  if (patch.role !== undefined) props.Role = text(patch.role);
  if (patch.location !== undefined) props.Location = text(patch.location);
  if (patch.email !== undefined) props.Email = { email: patch.email || null };
  if (patch.phone !== undefined) props.Phone = { phone_number: patch.phone || null };
  if (patch.linkedin !== undefined) props.LinkedIn = { url: patch.linkedin || null };
  if (patch.telegram !== undefined) props.Telegram = { url: patch.telegram || null };
  if (patch.needs_review !== undefined) props['Needs review'] = P.checkbox(patch.needs_review);
  if (patch.next_followup !== undefined) props['Next Follow-up'] = { date: patch.next_followup ? { start: patch.next_followup } : null };
  if (patch.company !== undefined) {
    props.Company = patch.company ? P.relation([(await findOrCreateCompany(d.notion, d.companiesDb, patch.company, null)).id]) : P.relation([]);
  }
  if (patch.note) {
    const current = plain(page.properties.Notes).trim();
    const line = `${today}: ${patch.note}`;
    props.Notes = P.rich(truncate(current ? `${current}\n${line}` : line, 1900));
  }
  const updated = await d.notion.updatePage(id, props);
  const { companies, events } = await lookups(d);
  return toPerson(updated, companies, events);
}

/** today + n days, as YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
