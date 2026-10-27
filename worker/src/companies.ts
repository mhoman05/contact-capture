import { cleanLinkedInLink, cleanWebsite, companyKey, nonEmpty, truncate } from './normalize';
import { P, pageTitle, plain, type NotionClient, type NotionPage } from './notion';
import type { HistoryItem } from './people';

export const INDUSTRIES = ['Crypto / Web3', 'Fintech', 'Banking', 'Health', 'Software', 'Advisory', 'Other'];
export const RELATIONSHIPS = ['Target', 'Prospect', 'Active', 'Partner', 'Dormant'];
export const PRIORITIES = ['High', 'Medium', 'Low'];

/** What the app shows and edits for one company. */
export interface CompanyItem {
  id: string;
  url: string;
  name: string;
  website: string;
  linkedin: string;
  location: string; // HQ / Location
  industry: string;
  relationship: string;
  priority: string; // Target Priority
  why: string; // Why They Matter
  notes: string;
  people_ids: string[]; // current people
  former_ids: string[];
  created: string;
  edited: string;
}

export interface CompanyDeps {
  notion: NotionClient;
  companiesDb: string;
  interactionsDb?: string;
  meetingsDb?: string;
}

export function toCompany(page: NotionPage): CompanyItem {
  const p = page.properties;
  return {
    id: page.id,
    url: page.url,
    name: pageTitle(page, 'Name'),
    website: p.Website?.url ?? '',
    linkedin: p.LinkedIn?.url ?? '',
    location: plain(p['HQ / Location']).trim(),
    industry: p.Industry?.select?.name ?? '',
    relationship: p.Relationship?.select?.name ?? '',
    priority: p['Target Priority']?.select?.name ?? '',
    why: plain(p['Why They Matter']).trim(),
    notes: plain(p.Notes).trim(),
    people_ids: (p.People?.relation ?? []).map((r: any) => r.id),
    former_ids: (p['Former People']?.relation ?? []).map((r: any) => r.id),
    created: page.created_time ?? '',
    edited: page.last_edited_time ?? page.created_time ?? '',
  };
}

/** One page (up to 100) of companies, most recently edited first; with `since`, only what changed. */
export async function listCompanies(d: CompanyDeps, opts: { cursor?: string; since?: string }): Promise<{ companies: CompanyItem[]; next_cursor: string | null }> {
  const res = await d.notion.queryPage(d.companiesDb, {
    page_size: 100,
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    ...(opts.since ? { filter: { timestamp: 'last_edited_time', last_edited_time: { after: opts.since } } } : {}),
    ...(opts.cursor ? { start_cursor: opts.cursor } : {}),
  });
  return { companies: res.results.map(toCompany), next_cursor: res.has_more ? res.next_cursor : null };
}

// ---- validation ---------------------------------------------------------------------------------

export interface CompanyFields {
  name?: string;
  website?: string;
  linkedin?: string;
  location?: string;
  industry?: string;
  relationship?: string;
  priority?: string;
  why?: string;
  notes?: string;
}

/** Values that are given but unreadable are reported back instead of silently dropped; '' clears a field. */
export function parseCompanyFields(o: Record<string, unknown>, requireName: boolean): CompanyFields | string {
  const f: CompanyFields = {};
  const bad: string[] = [];
  const str = (k: string, max: number) => (typeof o[k] === 'string' ? (nonEmpty(o[k] as string, max) ?? '') : undefined);
  const name = str('name', 150);
  if (name !== undefined || requireName) {
    if (!name) return 'Give the company a name.';
    f.name = name;
  }
  const web = str('website', 200);
  if (web !== undefined) {
    const c = web ? cleanWebsite(web) : '';
    if (c === null) bad.push('website');
    else f.website = c;
  }
  const li = str('linkedin', 300);
  if (li !== undefined) {
    const c = li ? cleanLinkedInLink(li) : '';
    if (c === null) bad.push('LinkedIn link');
    else f.linkedin = c;
  }
  const pick = (k: 'industry' | 'relationship' | 'priority', allowed: string[], label: string) => {
    const v = str(k, 40);
    if (v === undefined) return;
    if (v === '' || allowed.includes(v)) f[k] = v;
    else bad.push(label);
  };
  pick('industry', INDUSTRIES, 'industry');
  pick('relationship', RELATIONSHIPS, 'relationship');
  pick('priority', PRIORITIES, 'priority');
  for (const k of ['location', 'why', 'notes'] as const) {
    const v = str(k, k === 'location' ? 150 : 1900);
    if (v !== undefined) f[k] = v;
  }
  if (bad.length) return `Check the ${bad.join(', ')}: it could not be read.`;
  return f;
}

export function parseCompanyUpdate(raw: unknown): { id: string; fields: CompanyFields } | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[0-9a-z-]{6,40}$/i.test(o.id)) return 'Send the id of the company.';
  const f = parseCompanyFields(o, false);
  if (typeof f === 'string') return f;
  if (!Object.keys(f).length) return 'Nothing to change.';
  return { id: o.id, fields: f };
}

// ---- writing --------------------------------------------------------------------------------------

const dashless = (id: string) => id.replace(/-/g, '').toLowerCase();
const text = (s: string) => (s ? P.rich(truncate(s, 1900)) : { rich_text: [] });

function toProps(f: CompanyFields): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (f.name !== undefined) props.Name = P.title(f.name);
  if (f.website !== undefined) props.Website = { url: f.website || null };
  if (f.linkedin !== undefined) props.LinkedIn = { url: f.linkedin || null };
  if (f.location !== undefined) props['HQ / Location'] = text(f.location);
  if (f.industry !== undefined) props.Industry = f.industry ? P.select(f.industry) : { select: null };
  if (f.relationship !== undefined) props.Relationship = f.relationship ? P.select(f.relationship) : { select: null };
  if (f.priority !== undefined) props['Target Priority'] = f.priority ? P.select(f.priority) : { select: null };
  if (f.why !== undefined) props['Why They Matter'] = text(f.why);
  if (f.notes !== undefined) props.Notes = text(f.notes);
  return props;
}

/** Create a company, unless one with the same name (ignoring Inc., Ltd, GmbH …) exists: then that one is returned. */
export async function createCompany(d: CompanyDeps, f: CompanyFields): Promise<{ company: CompanyItem; existed: boolean }> {
  const key = companyKey(f.name ?? '');
  if (key) {
    const hit = (await d.notion.queryAll(d.companiesDb, 1000)).find((c) => companyKey(pageTitle(c, 'Name')) === key);
    if (hit) return { company: toCompany(hit), existed: true };
  }
  return { company: toCompany(await d.notion.createPage(d.companiesDb, toProps(f))), existed: false };
}

/** Change a company. Refuses any page that is not a row of the Companies database. Returns null in that case. */
export async function updateCompany(d: CompanyDeps, id: string, f: CompanyFields): Promise<CompanyItem | null> {
  const page = await d.notion.getPage(id);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(d.companiesDb)) return null;
  return toCompany(await d.notion.updatePage(id, toProps(f)));
}

/** Meetings and interactions of the company itself and of the people who work there, newest first. */
export async function companyHistory(d: CompanyDeps, id: string): Promise<HistoryItem[] | null> {
  const page = await d.notion.getPage(id);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(d.companiesDb)) return null;
  const people: string[] = (page.properties.People?.relation ?? []).map((r: any) => r.id).slice(0, 25);
  const filterFor = (companyProp: string, peopleProp: string) => ({
    or: [{ property: companyProp, relation: { contains: id } }, ...people.map((pid) => ({ property: peopleProp, relation: { contains: pid } }))],
  });
  const safe = (q: Promise<NotionPage[]>): Promise<NotionPage[]> => q.catch(() => []);
  const out: HistoryItem[] = [];
  const date = (m: NotionPage) => (m.properties.Date?.date?.start ?? '').slice(0, 10);
  if (d.meetingsDb) {
    for (const m of await safe(d.notion.query(d.meetingsDb, filterFor('Companies (direct)', 'Attendees'), 40))) {
      out.push({ kind: 'meeting', title: pageTitle(m, 'Name'), type: m.properties.Type?.select?.name ?? 'Meeting', date: date(m), summary: plain(m.properties['Topics Discussed']).trim(), url: m.url });
    }
  }
  if (d.interactionsDb) {
    for (const m of await safe(d.notion.query(d.interactionsDb, filterFor('Companies (direct)', 'People'), 40))) {
      out.push({ kind: 'interaction', title: pageTitle(m, 'Title'), type: m.properties.Type?.select?.name ?? 'Interaction', date: date(m), summary: plain(m.properties.Summary).trim(), url: m.url });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25);
}
