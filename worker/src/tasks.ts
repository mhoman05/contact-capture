import { nonEmpty, truncate } from './normalize';
import { P, pageTitle, plain, type NotionClient, type NotionPage } from './notion';

export const STATUSES = ['Not started', 'In progress', 'Backlog', 'Done'];
export const TASK_TYPES = ['Advisory', 'Personal', 'Work'];

/** What the app shows and edits for one row of the Task Database. */
export interface TaskItem {
  id: string;
  url: string;
  title: string;
  status: string;
  due: string; // YYYY-MM-DD or ''
  completed: string; // YYYY-MM-DD or ''
  types: string[];
  tags: string[];
  waiting: boolean; // someone else owes me this
  person_ids: string[];
  company_ids: string[];
  companies: string[]; // names of company_ids
  notes: string;
  next_step: string;
  created: string;
  edited: string;
}

export interface TaskDeps {
  notion: NotionClient;
  tasksDb: string;
  companiesDb: string;
}

const day = (p: any) => (p?.date?.start ?? '').slice(0, 10);

export function toTask(page: NotionPage, companies: Map<string, string>): TaskItem {
  const p = page.properties;
  const companyIds: string[] = (p['Company (direct)']?.relation ?? []).map((r: any) => r.id);
  return {
    id: page.id,
    url: page.url,
    title: pageTitle(page, 'Name'),
    status: p.Status?.status?.name ?? 'Not started',
    due: day(p['Due Date']),
    completed: day(p['Completion Date']),
    types: (p.Type?.multi_select ?? []).map((o: any) => o.name as string),
    tags: (p.Tags?.multi_select ?? []).map((o: any) => o.name as string),
    waiting: !!p['Waiting on']?.checkbox,
    person_ids: (p.Person?.relation ?? []).map((r: any) => r.id),
    company_ids: companyIds,
    companies: companyIds.map((id) => companies.get(id)).filter(Boolean) as string[],
    notes: plain(p.Notes).trim(),
    next_step: plain(p['Next Step']).trim(),
    created: page.created_time ?? '',
    edited: page.last_edited_time ?? page.created_time ?? '',
  };
}

let companyCache: { at: number; map: Map<string, string> } | null = null;
async function companyNames(d: TaskDeps, fresh = false): Promise<Map<string, string>> {
  if (!fresh && companyCache && Date.now() - companyCache.at < 60_000) return companyCache.map;
  const map = new Map<string, string>();
  for (const c of await d.notion.queryAll(d.companiesDb, 1000)) map.set(c.id, pageTitle(c, 'Name'));
  companyCache = { at: Date.now(), map };
  return map;
}

/**
 * One page (up to 100) of tasks, most recently edited first. Without `since`: every task that is not Done plus the
 * ones edited in the last 45 days (so recently completed tasks are there to undo). With `since`: only what changed.
 */
export async function listTasks(d: TaskDeps, opts: { cursor?: string; since?: string; all?: boolean }): Promise<{ tasks: TaskItem[]; next_cursor: string | null }> {
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString();
  const filter = opts.since
    ? { timestamp: 'last_edited_time', last_edited_time: { after: opts.since } }
    : { or: [{ property: 'Status', status: { does_not_equal: 'Done' } }, { timestamp: 'last_edited_time', last_edited_time: { after: cutoff } }] };
  // all: every task ever, oldest first (a stable order to page through, for the backup)
  const res = await d.notion.queryPage(d.tasksDb, {
    page_size: 100,
    sorts: [opts.all ? { timestamp: 'created_time', direction: 'ascending' } : { timestamp: 'last_edited_time', direction: 'descending' }],
    ...(opts.all ? {} : { filter }),
    ...(opts.cursor ? { start_cursor: opts.cursor } : {}),
  });
  const companies = await companyNames(d);
  return { tasks: res.results.map((r) => toTask(r, companies)), next_cursor: res.has_more ? res.next_cursor : null };
}

// ---- validation -------------------------------------------------------------------------------

export interface TaskFields {
  title?: string;
  status?: string;
  due?: string; // '' clears
  types?: string[];
  tags?: string[];
  waiting?: boolean;
  person_ids?: string[];
  company_ids?: string[];
  notes?: string;
  next_step?: string;
}

const ID = /^[0-9a-z-]{6,40}$/i;

/** Shared by create (title required) and update (everything optional). Reports what is wrong instead of dropping it. */
function parseFields(o: Record<string, unknown>, requireTitle: boolean): TaskFields | string {
  const f: TaskFields = {};
  if (o.title !== undefined || requireTitle) {
    const t = typeof o.title === 'string' ? nonEmpty(o.title, 200) : null;
    if (!t) return 'Give the task a title.';
    f.title = t;
  }
  if (o.status !== undefined) {
    if (typeof o.status !== 'string' || !STATUSES.includes(o.status)) return `Status must be one of: ${STATUSES.join(', ')}.`;
    f.status = o.status;
  }
  if (o.due !== undefined) {
    if (o.due !== '' && !(typeof o.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.due))) return 'The due date must look like 2026-10-28.';
    f.due = o.due as string;
  }
  const list = (key: 'types' | 'tags' | 'person_ids' | 'company_ids', ok: (s: string) => boolean, label: string, max: number): string | undefined => {
    if (o[key] === undefined) return;
    const v = o[key];
    if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && ok(x))) return `Check the ${label}.`;
    f[key] = [...new Set(v as string[])];
  };
  const err =
    list('types', (s) => TASK_TYPES.includes(s), 'task types', 3) ||
    list('tags', (s) => s.length > 0 && s.length <= 40 && !s.includes(','), 'tags', 12) ||
    list('person_ids', (s) => ID.test(s), 'people', 10) ||
    list('company_ids', (s) => ID.test(s), 'companies', 5);
  if (err) return err;
  if (o.waiting !== undefined) {
    if (typeof o.waiting !== 'boolean') return 'Waiting on must be true or false.';
    f.waiting = o.waiting;
  }
  if (o.notes !== undefined) f.notes = typeof o.notes === 'string' ? (nonEmpty(o.notes, 1900) ?? '') : '';
  if (o.next_step !== undefined) f.next_step = typeof o.next_step === 'string' ? (nonEmpty(o.next_step, 300) ?? '') : '';
  return f;
}

export function parseTaskCreate(raw: unknown): TaskFields | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  return parseFields(raw as Record<string, unknown>, true);
}

export function parseTaskUpdate(raw: unknown): { id: string; fields: TaskFields } | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id)) return 'Send the id of the task.';
  const f = parseFields(o, false);
  if (typeof f === 'string') return f;
  if (!Object.keys(f).length) return 'Nothing to change.';
  return { id: o.id, fields: f };
}

// ---- writing ----------------------------------------------------------------------------------

const dashless = (id: string) => id.replace(/-/g, '').toLowerCase();
const text = (s: string) => (s ? P.rich(truncate(s, 1900)) : { rich_text: [] });

function toProps(f: TaskFields, today: string, wasDone: boolean): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (f.title !== undefined) props.Name = P.title(f.title);
  if (f.status !== undefined) {
    props.Status = { status: { name: f.status } };
    if (f.status === 'Done') props['Completion Date'] = P.date(today); // completing sets the date, un-completing clears it
    else if (wasDone) props['Completion Date'] = { date: null };
  }
  if (f.due !== undefined) props['Due Date'] = f.due ? P.date(f.due) : { date: null };
  if (f.types !== undefined) props.Type = { multi_select: f.types.map((name) => ({ name })) };
  if (f.tags !== undefined) props.Tags = { multi_select: f.tags.map((name) => ({ name })) };
  if (f.waiting !== undefined) props['Waiting on'] = P.checkbox(f.waiting);
  if (f.person_ids !== undefined) props.Person = P.relation(f.person_ids);
  if (f.company_ids !== undefined) props['Company (direct)'] = P.relation(f.company_ids);
  if (f.notes !== undefined) props.Notes = text(f.notes);
  if (f.next_step !== undefined) props['Next Step'] = text(f.next_step);
  return props;
}

export async function createTask(d: TaskDeps, f: TaskFields, today: string): Promise<TaskItem> {
  // A task that is sent twice (a lost reply, or the offline queue retrying) must not appear twice.
  const recent = await d.notion.query(
    d.tasksDb,
    { and: [{ property: 'Name', title: { equals: f.title } }, { timestamp: 'created_time', created_time: { after: new Date(Date.now() - 10 * 60_000).toISOString() } }] },
    5,
  );
  const same = recent.find((t) => (t.properties.Status?.status?.name ?? '') !== 'Done');
  const companies = await companyNames(d, true);
  if (same) return toTask(same, companies);
  const page = await d.notion.createPage(d.tasksDb, toProps({ status: 'Not started', ...f }, today, false));
  return toTask(page, companies);
}

/** Change a task. Refuses any page that is not a row of the Task Database. Returns null in that case. */
export async function updateTask(d: TaskDeps, id: string, f: TaskFields, today: string): Promise<TaskItem | null> {
  const page = await d.notion.getPage(id);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(d.tasksDb)) return null;
  const wasDone = page.properties.Status?.status?.name === 'Done';
  const updated = await d.notion.updatePage(id, toProps(f, today, wasDone));
  return toTask(updated, await companyNames(d, f.company_ids !== undefined));
}

/** Move a task to Notion's trash (restorable there for 30 days). */
export async function deleteTask(d: TaskDeps, id: string): Promise<boolean> {
  const page = await d.notion.getPage(id);
  if (!page.parent?.database_id || dashless(page.parent.database_id) !== dashless(d.tasksDb)) return false;
  if (!page.archived) await d.notion.archivePage(id);
  return true;
}
