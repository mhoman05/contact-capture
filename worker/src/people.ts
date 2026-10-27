import { listEvents } from './events';
import { cleanEmail, cleanLinkedInLink, cleanPhone, cleanTelegram, linkedInSlug, nameTokens, nonEmpty, phoneDigits, sameName, similarName, telegramHandle, truncate } from './normalize';
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
  tier: string; // A - Key, B - Important, C - Network or ''
  contact_type: string[];
  needs_review: boolean;
  next_followup: string; // YYYY-MM-DD or ''
  created: string; // ISO time the person was added
  edited: string; // ISO time of the last edit in Notion
}

export interface PeopleDeps {
  notion: NotionClient;
  peopleDb: string;
  companiesDb: string;
  eventsDb?: string;
  meetingsDb?: string;
  interactionsDb?: string;
}

export const TIERS = ['A - Key', 'B - Important', 'C - Network'];

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
    tier: p.Tier?.select?.name ?? '',
    contact_type: (p['Contact Type']?.multi_select ?? []).map((o: any) => o.name as string),
    needs_review: !!p['Needs review']?.checkbox,
    next_followup: (p['Next Follow-up']?.date?.start ?? '').slice(0, 10),
    created: page.created_time ?? '',
    edited: page.last_edited_time ?? page.created_time ?? '',
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
  tier?: string;
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
  if (typeof o.tier === 'string') {
    if (o.tier === '' || TIERS.includes(o.tier)) patch.tier = o.tier;
    else bad.push('tier');
  }
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
  if (patch.tier !== undefined) props.Tier = patch.tier ? P.select(patch.tier) : { select: null };
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

// ---- removing, duplicates, merging ------------------------------------------------------------

export interface DeleteDeps extends PeopleDeps {
  interactionsDb: string;
}

const belongsTo = (page: NotionPage, db: string) => !!page.parent?.database_id && dashless(page.parent.database_id) === dashless(db);

/**
 * Move a person to Notion's trash, together with the "Met …" meetings that only involve them.
 * When the capture also created their company page and nobody else uses it, that goes too (Undo).
 */
export async function deletePerson(d: DeleteDeps, id: string, companyId?: string): Promise<{ person: string; meetings: number; company: boolean } | null> {
  const page = await d.notion.getPage(id);
  if (!belongsTo(page, d.peopleDb)) return null;
  let meetings = 0;
  const linked = await d.notion.query(d.interactionsDb, { property: 'People', relation: { contains: id } }, 50);
  for (const m of linked) {
    const only = (m.properties.People?.relation ?? []).length === 1;
    if (only && pageTitle(m, 'Title').startsWith('Met ')) {
      await d.notion.archivePage(m.id);
      meetings++;
    }
  }
  if (!page.archived) await d.notion.archivePage(id);
  let company = false;
  if (companyId) {
    const c = await d.notion.getPage(companyId);
    if (belongsTo(c, d.companiesDb) && !c.archived) {
      const users = await d.notion.query(d.peopleDb, { property: 'Company', relation: { contains: companyId } }, 1);
      if (!users.length) {
        await d.notion.archivePage(companyId);
        company = true;
      }
    }
  }
  return { person: pageTitle(page, 'Name'), meetings, company };
}

export interface DupePair {
  a: PersonItem;
  b: PersonItem;
  reasons: string[];
  strength: 'high' | 'medium';
  keep: 'a' | 'b'; // the one with more information (older when equal): the suggested one to keep
}

const filled = (p: PersonItem) => [p.email, p.phone, p.linkedin, p.telegram, p.role, p.company, p.location, p.how].filter(Boolean).length + Math.min(p.notes.length, 200) / 200;

/** Pairs of people who look like the same person, strongest first. Never merges anything by itself. */
export async function findDuplicates(d: PeopleDeps, max = 40): Promise<DupePair[]> {
  const { companies, events } = await lookups(d);
  const rows = await d.notion.queryAll(d.peopleDb, 1000);
  const people = rows.map((r) => toPerson(r, companies, events)).filter((p) => p.name);
  const pairs = new Map<string, { i: number; j: number; reasons: Set<string>; strong: boolean }>();
  const add = (i: number, j: number, reason: string, strong: boolean) => {
    if (i === j) return;
    const [x, y] = i < j ? [i, j] : [j, i];
    const k = `${x}:${y}`;
    const e = pairs.get(k) ?? { i: x, j: y, reasons: new Set<string>(), strong: false };
    e.reasons.add(reason);
    e.strong ||= strong;
    pairs.set(k, e);
  };
  const group = (label: string, key: (p: PersonItem) => string | null) => {
    const idx = new Map<string, number[]>();
    people.forEach((p, i) => {
      const k = key(p);
      if (k) idx.set(k, [...(idx.get(k) ?? []), i]);
    });
    for (const list of idx.values()) for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) add(list[a], list[b], label, true);
  };
  group('Same email', (p) => p.email.toLowerCase() || null);
  group('Same phone number', (p) => { const dg = phoneDigits(p.phone); return dg.length >= 8 ? dg.slice(-9) : null; });
  group('Same LinkedIn profile', (p) => linkedInSlug(p.linkedin));
  group('Same Telegram', (p) => telegramHandle(p.telegram));

  // Names: people with different email addresses are different people, whatever they are called.
  const conflict = (a: PersonItem, b: PersonItem) => (a.email && b.email && a.email.toLowerCase() !== b.email.toLowerCase()) || (a.linkedin && b.linkedin && linkedInSlug(a.linkedin) !== linkedInSlug(b.linkedin));
  const byToken = new Map<string, number[]>();
  people.forEach((p, i) => { for (const t of new Set(nameTokens(p.name))) byToken.set(t, [...(byToken.get(t) ?? []), i]); });
  people.forEach((p, i) => {
    const toks = [...new Set(nameTokens(p.name))];
    if (!toks.length) return;
    const lists = toks.map((t) => byToken.get(t) ?? []).sort((x, y) => x.length - y.length);
    for (const j of lists[0]) {
      if (j <= i || conflict(p, people[j])) continue;
      if (sameName(p.name, people[j].name)) add(i, j, 'Same name', false);
      else if (similarName(p.name, people[j].name)) add(i, j, 'Similar name', false);
    }
  });

  return [...pairs.values()]
    .map((e): DupePair => {
      const a = people[e.i], b = people[e.j];
      const sa = filled(a), sb = filled(b);
      const keep = sa > sb ? 'a' : sb > sa ? 'b' : (a.created <= b.created ? 'a' : 'b');
      return { a, b, reasons: [...e.reasons], strength: e.strong ? 'high' : 'medium', keep };
    })
    .sort((x, y) => (x.strength === y.strength ? 0 : x.strength === 'high' ? -1 : 1))
    .slice(0, max);
}

/** Merge `removeId` into `keepId`: fills empty fields, moves every link and the notes over, then trashes the duplicate. */
export async function mergePeople(d: PeopleDeps, keepId: string, removeId: string, today: string): Promise<PersonItem | null | 'same'> {
  if (keepId === removeId) return 'same';
  const [keep, gone] = await Promise.all([d.notion.getPage(keepId), d.notion.getPage(removeId)]);
  if (!belongsTo(keep, d.peopleDb) || !belongsTo(gone, d.peopleDb)) return null;
  const kp = keep.properties, gp = gone.properties;
  // Notion's JSON names the type of every property; looking at which value is present also works for hand-made data.
  const kind = (p: any): string => p?.type ?? ['email', 'phone_number', 'url', 'rich_text', 'select', 'date', 'relation'].find((k) => k in (p ?? {})) ?? '';
  const props: Record<string, unknown> = {};
  const isEmpty = (p: any): boolean => {
    if (!p) return true;
    switch (kind(p)) {
      case 'email': return !p.email;
      case 'phone_number': return !p.phone_number;
      case 'url': return !p.url;
      case 'rich_text': return plain(p).trim() === '';
      case 'select': return !p.select;
      case 'date': return !p.date;
      case 'relation': return (p.relation ?? []).length === 0;
      default: return true;
    }
  };
  const copy = (name: string) => {
    const g = gp[name];
    if (isEmpty(g) || !isEmpty(kp[name])) return;
    const t = kind(g);
    if (t === 'email') props[name] = { email: g.email };
    else if (t === 'phone_number') props[name] = { phone_number: g.phone_number };
    else if (t === 'url') props[name] = { url: g.url };
    else if (t === 'rich_text') props[name] = P.rich(plain(g));
    else if (t === 'select') props[name] = { select: { name: g.select.name } };
    else if (t === 'date') props[name] = { date: { start: g.date.start, end: g.date.end ?? null } };
  };
  for (const n of ['Email', 'Phone', 'LinkedIn', 'Telegram', 'Role', 'Location', 'How We Know Each Other', 'Tier', 'Birthday', 'Next Follow-up', 'Last Enriched']) copy(n);
  // Contact Type: both sets of tags
  if ((gp['Contact Type']?.multi_select ?? []).length) {
    const names = new Set<string>([...(kp['Contact Type']?.multi_select ?? []), ...gp['Contact Type'].multi_select].map((o: any) => o.name));
    props['Contact Type'] = { multi_select: [...names].map((name) => ({ name })) };
  }
  // Links: everything the duplicate was connected to now also points at the one you keep.
  for (const [name, g] of Object.entries<any>(gp)) {
    if (kind(g) !== 'relation') continue;
    const have: string[] = (kp[name]?.relation ?? []).map((r: any) => r.id);
    if (name === 'Company' && have.length) continue; // one company: keep yours
    const extra = (g.relation ?? []).map((r: any) => r.id).filter((x: string) => !have.includes(x) && x !== keepId && x !== removeId);
    if (extra.length) props[name] = P.relation(name === 'Company' ? extra.slice(0, 1) : [...have, ...extra]);
  }
  const goneNotes = plain(gp.Notes).trim();
  const keepNotes = plain(kp.Notes).trim();
  const line = `${today}: Merged with duplicate "${pageTitle(gone, 'Name')}".${goneNotes ? `\nNotes from the duplicate:\n${goneNotes}` : ''}`;
  props.Notes = P.rich(truncate(keepNotes ? `${keepNotes}\n${line}` : line, 1900));

  const updated = await d.notion.updatePage(keepId, props);
  await d.notion.archivePage(removeId); // last, so a failure above loses nothing
  const { companies, events } = await lookups(d);
  return toPerson(updated, companies, events);
}

// ---- browsing the whole People database ---------------------------------------------------------

// Company and event names change rarely and a sync reads many pages, so the name tables are kept for a minute.
let cache: { at: number; value: Awaited<ReturnType<typeof lookups>> } | null = null;
async function lookupsCached(d: PeopleDeps) {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const value = await lookups(d);
  cache = { at: Date.now(), value };
  return value;
}

/**
 * One page (up to 100) of people, most recently edited first. With `since`, only people edited after that moment,
 * so the app can keep its copy up to date cheaply and only read everything once.
 */
export async function listPeople(d: PeopleDeps, opts: { cursor?: string; since?: string }): Promise<{ people: PersonItem[]; next_cursor: string | null }> {
  const { companies, events } = await lookupsCached(d);
  const res = await d.notion.queryPage(d.peopleDb, {
    page_size: 100,
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    ...(opts.since ? { filter: { timestamp: 'last_edited_time', last_edited_time: { after: opts.since } } } : {}),
    ...(opts.cursor ? { start_cursor: opts.cursor } : {}),
  });
  return { people: res.results.map((r) => toPerson(r, companies, events)), next_cursor: res.has_more ? res.next_cursor : null };
}

export interface HistoryItem {
  kind: 'meeting' | 'interaction';
  title: string;
  type: string;
  date: string; // YYYY-MM-DD or ''
  summary: string;
  url: string;
}

/** Meetings (calendar) and interactions (calls, emails, events …) a person was part of, newest first. */
export async function personHistory(d: PeopleDeps, personId: string): Promise<HistoryItem[]> {
  const out: HistoryItem[] = [];
  // One source the app cannot see must not hide the other: show what is readable.
  const safe = async (pages: Promise<NotionPage[]>): Promise<NotionPage[]> => pages.catch(() => []);
  if (d.meetingsDb) {
    for (const m of await safe(d.notion.query(d.meetingsDb, { property: 'Attendees', relation: { contains: personId } }, 30))) {
      out.push({ kind: 'meeting', title: pageTitle(m, 'Name'), type: m.properties.Type?.select?.name ?? 'Meeting', date: (m.properties.Date?.date?.start ?? '').slice(0, 10), summary: plain(m.properties['Topics Discussed']).trim(), url: m.url });
    }
  }
  if (d.interactionsDb) {
    for (const m of await safe(d.notion.query(d.interactionsDb, { property: 'People', relation: { contains: personId } }, 30))) {
      out.push({ kind: 'interaction', title: pageTitle(m, 'Title'), type: m.properties.Type?.select?.name ?? 'Interaction', date: (m.properties.Date?.date?.start ?? '').slice(0, 10), summary: plain(m.properties.Summary).trim(), url: m.url });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
}
