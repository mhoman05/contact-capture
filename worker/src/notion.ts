import { companyKey, fold, linkedInSlug, telegramHandle, nameTokens, phoneDigits, sameName, similarName, truncate } from './normalize';

const NOTION_VERSION = '2022-06-28';

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// Only the parts of the Notion page JSON this code reads.
export interface NotionPage {
  id: string;
  url: string;
  properties: Record<string, any>;
  parent?: { type?: string; database_id?: string };
}

export class NotionClient {
  constructor(
    private readonly token: string,
    // Wrapped in an arrow function on purpose: Cloudflare Workers throw "Illegal invocation" if the global fetch is
    // stored on an object and called as a method (this.fetchImpl(...)).
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? '1'), 5) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      if (res.status === 401) throw new NotionError('Notion rejected the integration token.', 502);
      if (res.status === 404) {
        throw new NotionError('Notion cannot see that database: share the Work CRM page with the integration.', 502);
      }
      throw new NotionError(`Notion error ${res.status}: ${truncate(detail, 300)}`, 502);
    }
    return (await res.json()) as T;
  }

  async query(dbId: string, filter: unknown, pageSize = 25): Promise<NotionPage[]> {
    const res = await this.request<{ results: NotionPage[] }>('POST', `/databases/${dbId}/query`, {
      filter,
      page_size: pageSize,
    });
    return res.results;
  }

  /** Every row of a (small) database. Notion's text filters are accent-sensitive, so names are compared in code instead. */
  async queryAll(dbId: string, max = 500): Promise<NotionPage[]> {
    const rows: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const res = await this.request<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>(
        'POST',
        `/databases/${dbId}/query`,
        { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
      );
      rows.push(...res.results);
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor && rows.length < max);
    return rows;
  }

  getPage(pageId: string): Promise<NotionPage> {
    return this.request<NotionPage>('GET', `/pages/${pageId}`);
  }

  createPage(dbId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    return this.request<NotionPage>('POST', '/pages', { parent: { database_id: dbId }, properties });
  }

  updatePage(pageId: string, properties: Record<string, unknown>): Promise<NotionPage> {
    return this.request<NotionPage>('PATCH', `/pages/${pageId}`, { properties });
  }
}

// ---- property readers / writers -------------------------------------------------------------

const text = (s: string) => [{ type: 'text', text: { content: truncate(s, 1900) } }];
export const P = {
  title: (s: string) => ({ title: text(s) }),
  rich: (s: string) => ({ rich_text: text(s) }),
  email: (s: string) => ({ email: s }),
  phone: (s: string) => ({ phone_number: s }),
  url: (s: string) => ({ url: s }),
  relation: (ids: string[]) => ({ relation: ids.map((id) => ({ id })) }),
  select: (s: string) => ({ select: { name: s } }),
  date: (s: string) => ({ date: { start: s } }),
  checkbox: (b: boolean) => ({ checkbox: b }),
};

export function plain(prop: any): string {
  const arr = prop?.rich_text ?? prop?.title ?? [];
  return arr.map((t: any) => t.plain_text ?? t.text?.content ?? '').join('');
}

export function pageTitle(page: NotionPage, titleProp: string): string {
  return plain(page.properties[titleProp]);
}

// ---- people ---------------------------------------------------------------------------------

export interface PersonLookup {
  match: NotionPage | null;
  matchedBy: 'email' | 'linkedin' | 'telegram' | 'name' | null;
  similar: NotionPage[]; // possible duplicates, never merged automatically
}

export async function findPerson(
  notion: NotionClient,
  dbId: string,
  c: { full_name: string; email: string | null; linkedin_url: string | null; telegram_url?: string | null },
): Promise<PersonLookup> {
  if (c.email) {
    const hit = await notion.query(dbId, { property: 'Email', email: { equals: c.email } }, 1);
    if (hit[0]) return { match: hit[0], matchedBy: 'email', similar: [] };
  }
  const slug = linkedInSlug(c.linkedin_url);
  if (slug) {
    const hits = await notion.query(dbId, { property: 'LinkedIn', url: { contains: slug } }, 5);
    const exact = hits.find((h) => linkedInSlug(h.properties.LinkedIn?.url) === slug);
    if (exact) return { match: exact, matchedBy: 'linkedin', similar: [] };
  }
  const handle = telegramHandle(c.telegram_url);
  if (handle) {
    const hits = await notion.query(dbId, { property: 'Telegram', url: { contains: handle } }, 5);
    const exact = hits.find((h) => telegramHandle(h.properties.Telegram?.url) === handle);
    if (exact) return { match: exact, matchedBy: 'telegram', similar: [] };
  }
  if (nameTokens(c.full_name).length === 0) return { match: null, matchedBy: null, similar: [] };
  const candidates = await notion.queryAll(dbId);
  const exact = candidates.find((p) => sameName(pageTitle(p, 'Name'), c.full_name));
  if (exact) return { match: exact, matchedBy: 'name', similar: [] };
  const similar = candidates.filter((p) => similarName(pageTitle(p, 'Name'), c.full_name)).slice(0, 3);
  return { match: null, matchedBy: null, similar };
}

// ---- companies ------------------------------------------------------------------------------

export interface CompanyRef {
  id: string;
  name: string;
  created: boolean;
}

export async function findOrCreateCompany(
  notion: NotionClient,
  dbId: string,
  name: string,
  website: string | null,
): Promise<CompanyRef> {
  const key = companyKey(name);
  if (key) {
    const candidates = await notion.queryAll(dbId);
    const hit = candidates.find((p) => companyKey(pageTitle(p, 'Name')) === key);
    if (hit) return { id: hit.id, name: pageTitle(hit, 'Name'), created: false };
  }
  const props: Record<string, unknown> = { Name: P.title(name) };
  if (website) props.Website = P.url(website);
  const page = await notion.createPage(dbId, props);
  return { id: page.id, name, created: true };
}

// ---- upsert ---------------------------------------------------------------------------------

export interface PersonInput {
  full_name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  telegram_url?: string | null;
  location: string | null;
  notes: string | null;
  company: CompanyRef | null;
  note: string; // where/how the user met them
  today: string;
  source: string; // "business card", "email signature" ...
}

export interface UpsertOutcome {
  page: NotionPage;
  action: 'created' | 'updated' | 'unchanged';
  added: string[];
  warnings: string[];
}

/** One dated line for the Notes field: what you typed, what the card said, and which fields this capture filled in. */
function noteLine(input: PersonInput, filled: string[] = []): string {
  const bits = [input.note, input.notes, filled.length ? `Filled in: ${filled.join(', ')}` : ''].filter(Boolean).join(' · ');
  return bits ? `${input.today}: ${bits}` : '';
}

export async function createPerson(notion: NotionClient, dbId: string, input: PersonInput): Promise<UpsertOutcome> {
  const props: Record<string, unknown> = { Name: P.title(input.full_name) };
  const added: string[] = [];
  const set = (field: string, value: unknown, label = field) => {
    props[field] = value;
    added.push(label);
  };
  if (input.email) set('Email', P.email(input.email));
  if (input.phone) set('Phone', P.phone(input.phone));
  if (input.linkedin_url) set('LinkedIn', P.url(input.linkedin_url));
  if (input.telegram_url) set('Telegram', P.url(input.telegram_url));
  if (input.job_title) set('Role', P.rich(input.job_title));
  if (input.location) set('Location', P.rich(input.location));
  if (input.company) set('Company', P.relation([input.company.id]));
  if (input.note) set('How We Know Each Other', P.rich(input.note));
  props['Needs review'] = P.checkbox(true); // shows up in the "To review (captured)" view until you untick it
  props.Notes = P.rich([`Added from ${input.source} on ${input.today}.`, input.notes].filter(Boolean).join(' '));
  const page = await notion.createPage(dbId, props);
  return { page, action: 'created', added, warnings: [] };
}

export async function updatePerson(
  notion: NotionClient,
  existing: NotionPage,
  input: PersonInput,
): Promise<UpsertOutcome> {
  const p = existing.properties;
  const props: Record<string, unknown> = {};
  const added: string[] = [];
  const warnings: string[] = [];
  const empty = (prop: any, kind: 'email' | 'phone_number' | 'url' | 'rich_text' | 'relation') => {
    if (kind === 'rich_text') return plain(prop).trim() === '';
    if (kind === 'relation') return (prop?.relation ?? []).length === 0;
    return !prop?.[kind];
  };

  if (input.email) {
    if (empty(p.Email, 'email')) {
      props.Email = P.email(input.email);
      added.push('Email');
    } else if (p.Email.email.toLowerCase() !== input.email) {
      warnings.push(`The CRM has ${p.Email.email}; the card shows ${input.email}. Left unchanged.`);
    }
  }
  if (input.phone) {
    if (empty(p.Phone, 'phone_number')) {
      props.Phone = P.phone(input.phone);
      added.push('Phone');
    } else if (phoneDigits(p.Phone.phone_number) !== phoneDigits(input.phone)) {
      warnings.push(`The CRM has ${p.Phone.phone_number}; the card shows ${input.phone}. Left unchanged.`);
    }
  }
  if (input.linkedin_url && empty(p.LinkedIn, 'url')) {
    props.LinkedIn = P.url(input.linkedin_url);
    added.push('LinkedIn');
  }
  if (input.telegram_url && empty(p.Telegram, 'url')) {
    props.Telegram = P.url(input.telegram_url);
    added.push('Telegram');
  }
  if (input.job_title) {
    if (empty(p.Role, 'rich_text')) {
      props.Role = P.rich(input.job_title);
      added.push('Role');
    } else if (fold(plain(p.Role)) !== fold(input.job_title)) {
      warnings.push(`Role on the card is "${input.job_title}"; the CRM has "${plain(p.Role)}". Left unchanged.`);
    }
  }
  if (input.location && empty(p.Location, 'rich_text')) {
    props.Location = P.rich(input.location);
    added.push('Location');
  }
  if (input.company) {
    if (empty(p.Company, 'relation')) {
      props.Company = P.relation([input.company.id]);
      added.push('Company');
    } else if (!(p.Company.relation ?? []).some((r: any) => r.id === input.company!.id)) {
      warnings.push(`The card shows ${input.company.name}, which differs from the company in the CRM. Left unchanged.`);
    }
  }
  if (input.note && empty(p['How We Know Each Other'], 'rich_text')) {
    props['How We Know Each Other'] = P.rich(input.note);
    added.push('How We Know Each Other');
  }
  const line = noteLine(input, added);
  if (line) {
    const current = plain(p.Notes).trim();
    if (!current.includes(line)) {
      props.Notes = P.rich(current ? `${current}\n${line}` : line);
      added.push('Notes');
    }
  }

  if (Object.keys(props).length === 0) return { page: existing, action: 'unchanged', added, warnings };
  const page = await notion.updatePage(existing.id, props);
  return { page, action: 'updated', added, warnings };
}

// ---- interactions ---------------------------------------------------------------------------

export async function createMeeting(
  notion: NotionClient,
  dbId: string,
  personId: string,
  personName: string,
  note: string,
  today: string,
): Promise<NotionPage> {
  return notion.createPage(dbId, {
    Title: P.title(`Met ${personName}`),
    Type: P.select('In person'),
    Date: P.date(today),
    People: P.relation([personId]),
    'Needs follow-up': P.checkbox(false),
    Summary: P.rich(note || 'Met in person. Added from the contact capture app.'),
  });
}
