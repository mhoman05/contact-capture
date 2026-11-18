import type { NotionPage } from './notion';
import Anthropic from '@anthropic-ai/sdk';
import { runCapture } from './capture';
import { DEFAULT_MODEL, ExtractionError, extractContacts } from './extract';
import { logInteraction, parseLog } from './interactions';
import { checkNotion } from './status';
import { companyHistory, createCompany, listCompanies, parseCompanyFields, parseCompanyUpdate, updateCompany } from './companies';
import { createTask, deleteTask, listTasks, parseTaskCreate, parseTaskUpdate, updateTask } from './tasks';
import { vcardResponse } from './vcard';
import { lookup, parseLookupRequest } from './lookup';
import { exportInteractions, exportMeetings } from './export';
import { addMeetingNotes, isDay, listMeetings } from './meetings';
import { GoogleError, parseGoogleContact, saveToGoogle } from './google';
import { createEvent, getEvent, listEvents, parseNewEvent } from './events';
import { readMe, updateMeValue } from './me';
import { libraryStatus, libraryUpload, isApp, listBackups, loadBackup, parseSave, saveBackup } from './backup';
import { deletePerson, findDuplicates, listPeople, mergePeople, parsePatch, personHistory, updatePersonFields } from './people';
import { NotionClient, NotionError, pageTitle, plain } from './notion';
import { cleanEmail, cleanLinkedInLink, cleanPhone, cleanTelegram, cleanWebsite, nonEmpty } from './normalize';
import type { CaptureImage, CaptureRequest, Env, ManualContact } from './types';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 12; // a bulk run after a conference
const MAX_IMAGE_B64 = 6 * 1024 * 1024; // base64 characters per image (the app downsizes to well under this)
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Notion's paging cursors are opaque and can be long and contain characters such as + / : ; it only goes into a JSON body to Notion, so any printable text is fine. */
export function isValidCursor(c: string): boolean {
  return /^[\x21-\x7e]{1,2000}$/.test(c);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** Compare secrets via their SHA-256 digests so the comparison time does not depend on where they differ. */
async function secretsMatch(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** The typed-in contact. Values that are given but unreadable are reported back instead of silently dropped. */
export function parseManual(raw: unknown): ManualContact | string | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return 'contact must be an object.';
  const o = raw as Record<string, unknown>;
  const get = (k: string, max: number) => (typeof o[k] === 'string' ? nonEmpty(o[k] as string, max) : null);
  const name = get('name', 120);
  if (!name) return 'Type at least a name.';
  const bad: string[] = [];
  const checked = <T>(label: string, input: string | null, clean: (s: string) => T | null): T | null => {
    if (!input) return null;
    const v = clean(input);
    if (v == null) bad.push(label);
    return v;
  };
  const email = checked('email address', get('email', 200), cleanEmail);
  const phone = checked('phone number', get('phone', 60), cleanPhone);
  const linkedin_url = checked('LinkedIn link', get('linkedin', 300), cleanLinkedInLink);
  const telegram_url = checked('Telegram username', get('telegram', 100), cleanTelegram);
  const website = checked('website', get('website', 200), cleanWebsite);
  if (bad.length) return `Check the ${bad.join(', ')}: it could not be read.`;
  return {
    source: o.source === 'qr' ? 'a scanned QR code' : 'typed in',
    contact: {
      full_name: name,
      email,
      phone,
      job_title: get('role', 150),
      company: get('company', 120),
      linkedin_url,
      website,
      location: null,
      notes: null,
      telegram_url,
    },
  };
}

export function parseRequest(raw: unknown, fallbackToday: string): CaptureRequest | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  const o = raw as Record<string, unknown>;
  const imagesIn = Array.isArray(o.images) ? o.images : [];
  if (imagesIn.length > MAX_IMAGES) return `At most ${MAX_IMAGES} images per request.`;
  const images: CaptureImage[] = [];
  for (const im of imagesIn) {
    const i = im as Record<string, unknown>;
    if (typeof i?.media_type !== 'string' || !MEDIA_TYPES.has(i.media_type)) return 'Unsupported image type.';
    if (typeof i.data !== 'string' || i.data.length === 0 || i.data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(i.data)) {
      return 'Invalid or oversized image data.';
    }
    const imgNote = typeof i.note === 'string' ? nonEmpty(i.note, 500) : null;
    images.push({ media_type: i.media_type as CaptureImage['media_type'], data: i.data, ...(imgNote ? { note: imgNote } : {}) });
  }
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 8000) : '';
  const followUp = typeof o.follow_up_days === 'number' && Number.isInteger(o.follow_up_days) && o.follow_up_days > 0 && o.follow_up_days <= 90 ? o.follow_up_days : 0;
  const eventId = typeof o.event_id === 'string' && o.event_id ? o.event_id : undefined;
  if (eventId && !/^[0-9a-z-]{6,40}$/i.test(eventId)) return 'event_id is not valid.';
  const manual = parseManual(o.contact);
  if (typeof manual === 'string') return manual;
  if (!images.length && !text && !manual) return 'Send at least one image, some text or a contact.';
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '';
  const today = typeof o.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.today) ? o.today : fallbackToday;
  // A meeting is only ever logged for photos or a typed contact (someone you are meeting), and only when asked for.
  // Text (an email signature) is never a meeting.
  const log_meeting = (images.length > 0 || !!manual) && o.log_meeting === true;
  return { images, text, note, today, log_meeting, ...(manual ? { manual } : {}), ...(eventId ? { event_id: eventId } : {}), ...(followUp ? { follow_up_days: followUp } : {}) };
}

/** The details you may share about yourself (Notion database "My sharing details"). */
async function handleMe(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.NOTION_ME_DB) return json({ error: 'NOTION_ME_DB is not set.' }, 503);
  const notion = new NotionClient(env.NOTION_TOKEN);
  try {
    if (path === '/me') return json({ items: await readMe(notion, env.NOTION_ME_DB) }, 200);
    const raw = await req.text();
    if (raw.length > 10_000) return json({ error: 'Request too large.' }, 413);
    let body: { id?: unknown; value?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    if (typeof body.id !== 'string' || !/^[0-9a-z-]{6,40}$/i.test(body.id) || typeof body.value !== 'string') {
      return json({ error: 'Send {"id": "<row id>", "value": "<text>"}.' }, 400);
    }
    const item = await updateMeValue(notion, env.NOTION_ME_DB, body.id, body.value.trim().slice(0, 1900));
    return item ? json({ item }, 200) : json({ error: 'That row is not in My sharing details.' }, 404);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** Meetings for the "Next meetings" card, and notes added after a meeting. */
async function handleMeetings(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.NOTION_MEETINGS_DB) return json({ error: 'NOTION_MEETINGS_DB is not set.' }, 503);
  const notion = new NotionClient(env.NOTION_TOKEN);
  try {
    if (url.pathname === '/meetings/upcoming') {
      const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
      const from = url.searchParams.get('from') ?? day(-1);
      const to = url.searchParams.get('to') ?? day(8);
      if (!isDay(from) || !isDay(to)) return json({ error: 'from and to must look like 2026-10-28.' }, 400);
      return json({ meetings: await listMeetings(notion, env.NOTION_MEETINGS_DB, from, to) }, 200);
    }
    const raw = await req.text();
    if (raw.length > 10_000) return json({ error: 'Request too large.' }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1500) : '';
    if (typeof body.id !== 'string' || !/^[0-9a-z-]{6,40}$/i.test(body.id) || !note) return json({ error: 'Send the id of the meeting and a note.' }, 400);
    const today = isDay(body.today) ? body.today : new Date().toISOString().slice(0, 10);
    const meeting = await addMeetingNotes(notion, env.NOTION_MEETINGS_DB, body.id, note, today);
    return meeting ? json({ meeting }, 200) : json({ error: 'That meeting is not in your Meetings database.' }, 404);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** A page of Interactions or Meetings for the backup. */
async function handleExport(env: Env, url: URL): Promise<Response> {
  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor && !isValidCursor(cursor)) return json({ error: 'Bad cursor.' }, 400);
  const notion = new NotionClient(env.NOTION_TOKEN);
  try {
    if (url.pathname === '/export/interactions') return json(await exportInteractions(notion, env.NOTION_INTERACTIONS_DB, cursor), 200);
    if (!env.NOTION_MEETINGS_DB) return json({ rows: [], next_cursor: null }, 200); // no Meetings database configured: nothing to back up
    return json(await exportMeetings(notion, env.NOTION_MEETINGS_DB, cursor), 200);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** Follows a scanned LinkedIn or WhatsApp short link for the app (see lookup.ts). */
async function handleLookup(req: Request): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 2_000) return json({ error: 'Request too large.' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Body is not valid JSON.' }, 400);
  }
  const target = parseLookupRequest(body);
  if (typeof target === 'string') return json({ error: target }, 400);
  try {
    return json(await lookup(target), 200);
  } catch {
    return json({ error: 'Could not look that up.' }, 502);
  }
}

/** "Save to phone contacts": adds one person to the owner's Google Contacts, which Android syncs to the phone. */
async function handleGoogleContact(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 20_000) return json({ error: 'Request too large.' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Body is not valid JSON.' }, 400);
  }
  const parsed = parseGoogleContact(body);
  if (typeof parsed === 'string') return json({ error: parsed }, 400);
  try {
    return json(await saveToGoogle(env, parsed), 200);
  } catch (err) {
    if (err instanceof GoogleError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** The people list of the "Recent" tab: the latest additions, and edits to one person. */
async function handlePeople(req: Request, env: Env, url: URL): Promise<Response> {
  const deps = {
    notion: new NotionClient(env.NOTION_TOKEN),
    peopleDb: env.NOTION_PEOPLE_DB,
    companiesDb: env.NOTION_COMPANIES_DB,
    eventsDb: env.NOTION_EVENTS_DB,
    meetingsDb: env.NOTION_MEETINGS_DB,
    interactionsDb: env.NOTION_INTERACTIONS_DB,
  };
  try {
    if (url.pathname === '/people/list') {
      const since = url.searchParams.get('since') ?? undefined;
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if ((since && Number.isNaN(Date.parse(since))) || (cursor && !isValidCursor(cursor))) return json({ error: 'Bad since or cursor.' }, 400);
      return json(await listPeople(deps, { since, cursor }), 200);
    }
    if (url.pathname === '/people/history') {
      const pid = url.searchParams.get('id') ?? '';
      if (!/^[0-9a-z-]{6,40}$/i.test(pid)) return json({ error: 'Send the id of the person.' }, 400);
      return json({ history: await personHistory(deps, pid) }, 200);
    }
    if (url.pathname === '/people/duplicates') return json({ pairs: await findDuplicates(deps) }, 200);
    const raw = await req.text();
    if (raw.length > 20_000) return json({ error: 'Request too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    const id = (v: unknown) => (typeof v === 'string' && /^[0-9a-z-]{6,40}$/i.test(v) ? v : null);
    const b = (body ?? {}) as Record<string, unknown>;
    if (url.pathname === '/people/delete') {
      if (!id(b.id) || (b.company_id != null && !id(b.company_id))) return json({ error: 'Send the id of the person.' }, 400);
      if (!env.NOTION_INTERACTIONS_DB) return json({ error: 'NOTION_INTERACTIONS_DB is not set.' }, 503);
      const removed = await deletePerson({ ...deps, interactionsDb: env.NOTION_INTERACTIONS_DB }, b.id as string, (b.company_id as string | undefined) ?? undefined);
      return removed ? json({ removed }, 200) : json({ error: 'That person is not in your People database.' }, 404);
    }
    if (url.pathname === '/people/merge') {
      if (!id(b.keep_id) || !id(b.remove_id)) return json({ error: 'Send keep_id and remove_id.' }, 400);
      const day = typeof b.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date().toISOString().slice(0, 10);
      const merged = await mergePeople(deps, b.keep_id as string, b.remove_id as string, day);
      if (merged === 'same') return json({ error: 'Pick two different people.' }, 400);
      return merged ? json({ person: merged }, 200) : json({ error: 'Both people must be in your People database.' }, 404);
    }
    const parsed = parsePatch(body);
    if (typeof parsed === 'string') return json({ error: parsed }, 400);
    const today = typeof (body as { today?: unknown }).today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test((body as { today: string }).today) ? (body as { today: string }).today : new Date().toISOString().slice(0, 10);
    const person = await updatePersonFields(deps, parsed.id, parsed.patch, today);
    return person ? json({ person }, 200) : json({ error: 'That person is not in your People database.' }, 404);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** Log a meeting or interaction with people, from a person's screen. */
async function handleLog(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  if (raw.length > 20_000) return json({ error: 'Request too large.' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Body is not valid JSON.' }, 400);
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const today = typeof b.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date().toISOString().slice(0, 10);
  const f = parseLog(body, today);
  if (typeof f === 'string') return json({ error: f }, 400);
  const notion = new NotionClient(env.NOTION_TOKEN);
  try {
    // The people must be rows of the People database, and their names make the title.
    const names: string[] = [];
    for (const id of f.person_ids) {
      const page = await notion.getPage(id);
      if (!page.parent?.database_id || page.parent.database_id.replace(/-/g, '').toLowerCase() !== env.NOTION_PEOPLE_DB.replace(/-/g, '').toLowerCase()) {
        return json({ error: 'That person is not in your People database.' }, 404);
      }
      names.push(pageTitle(page, 'Name'));
    }
    const logged = await logInteraction({ notion, interactionsDb: env.NOTION_INTERACTIONS_DB, meetingsDb: env.NOTION_MEETINGS_DB }, f, names.length > 2 ? `${names[0]} and ${names.length - 1} others` : names.join(' and '));
    return json({ logged }, 200);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    if (err instanceof Error && /not configured/.test(err.message)) return json({ error: err.message }, 503);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** The Companies database: list (paged, incremental), history, create and change. */
async function handleCompanies(req: Request, env: Env, url: URL): Promise<Response> {
  const deps = { notion: new NotionClient(env.NOTION_TOKEN), companiesDb: env.NOTION_COMPANIES_DB, interactionsDb: env.NOTION_INTERACTIONS_DB, meetingsDb: env.NOTION_MEETINGS_DB };
  try {
    if (url.pathname === '/companies/list') {
      const since = url.searchParams.get('since') ?? undefined;
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if ((since && Number.isNaN(Date.parse(since))) || (cursor && !isValidCursor(cursor))) return json({ error: 'Bad since or cursor.' }, 400);
      return json(await listCompanies(deps, { since, cursor }), 200);
    }
    if (url.pathname === '/companies/history') {
      const cid = url.searchParams.get('id') ?? '';
      if (!/^[0-9a-z-]{6,40}$/i.test(cid)) return json({ error: 'Send the id of the company.' }, 400);
      const history = await companyHistory(deps, cid);
      return history ? json({ history }, 200) : json({ error: 'That company is not in your Companies database.' }, 404);
    }
    const raw = await req.text();
    if (raw.length > 20_000) return json({ error: 'Request too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    if (url.pathname === '/companies/create') {
      const f = parseCompanyFields((body ?? {}) as Record<string, unknown>, true);
      return typeof f === 'string' ? json({ error: f }, 400) : json(await createCompany(deps, f), 200);
    }
    const p = parseCompanyUpdate(body);
    if (typeof p === 'string') return json({ error: p }, 400);
    const company = await updateCompany(deps, p.id, p.fields);
    return company ? json({ company }, 200) : json({ error: 'That company is not in your Companies database.' }, 404);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** The Task Database: list (paged, incremental), create, change (also completing) and delete. */
async function handleTasks(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.NOTION_TASKS_DB) return json({ error: 'NOTION_TASKS_DB is not set.' }, 503);
  const deps = { notion: new NotionClient(env.NOTION_TOKEN), tasksDb: env.NOTION_TASKS_DB, companiesDb: env.NOTION_COMPANIES_DB };
  try {
    if (url.pathname === '/tasks/list') {
      const since = url.searchParams.get('since') ?? undefined;
      const cursor = url.searchParams.get('cursor') ?? undefined;
      if ((since && Number.isNaN(Date.parse(since))) || (cursor && !isValidCursor(cursor))) return json({ error: 'Bad since or cursor.' }, 400);
      return json(await listTasks(deps, { since, cursor, all: url.searchParams.get('all') === '1' }), 200);
    }
    const raw = await req.text();
    if (raw.length > 20_000) return json({ error: 'Request too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const today = typeof b.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date().toISOString().slice(0, 10);
    if (url.pathname === '/tasks/create') {
      const f = parseTaskCreate(body);
      return typeof f === 'string' ? json({ error: f }, 400) : json({ task: await createTask(deps, f, today) }, 200);
    }
    if (url.pathname === '/tasks/update') {
      const p = parseTaskUpdate(body);
      if (typeof p === 'string') return json({ error: p }, 400);
      const task = await updateTask(deps, p.id, p.fields, today);
      return task ? json({ task }, 200) : json({ error: 'That task is not in your Task Database.' }, 404);
    }
    if (typeof b.id !== 'string' || !/^[0-9a-z-]{6,40}$/i.test(b.id)) return json({ error: 'Send the id of the task.' }, 400);
    return (await deleteTask(deps, b.id)) ? json({ ok: true }, 200) : json({ error: 'That task is not in your Task Database.' }, 404);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

/** The Events database: list the events to choose from, or create a new one. */
async function handleEvents(req: Request, env: Env, path: string): Promise<Response> {
  if (!env.NOTION_EVENTS_DB) return json({ error: 'NOTION_EVENTS_DB is not set.' }, 503);
  const notion = new NotionClient(env.NOTION_TOKEN);
  try {
    if (path === '/events') return json({ events: await listEvents(notion, env.NOTION_EVENTS_DB) }, 200);
    const raw = await req.text();
    if (raw.length > 10_000) return json({ error: 'Request too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    const parsed = parseNewEvent(body, new Date().toISOString().slice(0, 10));
    if (typeof parsed === 'string') return json({ error: parsed }, 400);
    return json({ event: await createEvent(notion, env.NOTION_EVENTS_DB, parsed) }, 200);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

// ---- shared backup of the phone apps -------------------------------------------------------------
// My Day and Racket Rankings live at other web addresses, so the browser needs to be told they may call this service (CORS).
// Only those two origins are allowed, and every call still needs the access token.
const BACKUP_ORIGINS = ['https://mydayappmh.github.io', 'https://matthias-sport.github.io', 'https://gymmh.github.io', 'https://librarymh.github.io'];
function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get('Origin') ?? '';
  if (!BACKUP_ORIGINS.includes(origin)) return res;
  const out = new Response(res.body, res);
  out.headers.set('Access-Control-Allow-Origin', origin);
  out.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  out.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  out.headers.set('Access-Control-Max-Age', '86400');
  out.headers.append('Vary', 'Origin');
  return out;
}
const BACKUP_BODY_MAX = 500_000;
async function handleBackup(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  const upload=/^\/backup\/library-upload\/(start|part|commit)$/.exec(url.pathname);
  const want = url.pathname === '/backup/save'||upload ? 'POST' : 'GET';
  if (!upload&&!['/backup/save', '/backup/load', '/backup/list'].includes(url.pathname)) return json({ error: 'Not found.' }, 404);
  if (req.method !== want) return json({ error: `Use ${want}.` }, 405);
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!env.CAPTURE_TOKEN || !token || !(await secretsMatch(token, env.CAPTURE_TOKEN))) return json({ error: 'Wrong or missing access token.' }, 401);
  if (!env.NOTION_BACKUPS_DB) return json({ error: 'NOTION_BACKUPS_DB is not set.' }, 503);
  const uploadDeadline=Date.now()+60000;
  const notion = new NotionClient(env.NOTION_TOKEN,upload?((input,init)=>{const left=uploadDeadline-Date.now();if(left<=0)throw Error('Backup request paused at its time limit. Previous backups remain available.');return fetch(input,{...init,signal:AbortSignal.timeout(Math.min(15000,left))});}):undefined,!!upload);
  try {
    if (url.pathname === '/backup/list') return json({ backups: await listBackups(notion, env.NOTION_BACKUPS_DB) }, 200);
    if (url.pathname === '/backup/load') {
      const app = url.searchParams.get('app');
      if (!isApp(app)) return json({ error: 'app must be myday, rankings or crm.' }, 400);
      const b = await loadBackup(notion, env.NOTION_BACKUPS_DB, app);
      return b ? json(b, 200) : json({ error: 'There is no backup of that app yet.' }, 404);
    }
    const raw = await req.text();
    if (raw.length > BACKUP_BODY_MAX) return json({ error: 'Request too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    if(upload){try{return json(await libraryUpload(notion,env.NOTION_BACKUPS_DB,upload[1],body),200);}catch(e){const retry=e instanceof NotionError?e.retryAfter:undefined;return json({error:e instanceof Error?e.message:'Backup upload failed.',...(retry?{retry_after:retry}:{})},retry?429:502);}}
    const parsed = parseSave(body);
    if (typeof parsed === 'string') return json({ error: parsed }, 400);
    return json({ backup: await saveBackup(notion, env.NOTION_BACKUPS_DB, parsed) }, 200);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') return json({ ok: true }, 200);
    if (url.pathname === '/backup/library-export'||url.pathname==='/backup/library-export/status') {
      if (req.method === 'OPTIONS') return withCors(req, new Response(null,{status:204}));
      const auth=req.headers.get('Authorization')??'';
      if(!env.CAPTURE_TOKEN || !auth.startsWith('Bearer ') || !(await secretsMatch(auth.slice(7),env.CAPTURE_TOKEN))) return withCors(req,json({error:'Wrong or missing access token.'},401));
      if(req.method!==(url.pathname.endsWith('/status')?'GET':'POST')) return withCors(req,json({error:'Wrong method.'},405));
      if(!env.NOTION_LIBRARY_BOOKS_DB || !env.NOTION_LIBRARY_TAKEAWAYS_DB) return withCors(req,json({error:'Library export destinations are not configured.'},503));
      try {
        if(url.pathname.endsWith('/status'))return withCors(req,json(await libraryStatus(new NotionClient(env.NOTION_TOKEN,(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)}),true),env.NOTION_LIBRARY_BOOKS_DB,env.NOTION_LIBRARY_TAKEAWAYS_DB,url.searchParams.get('kind')??'',url.searchParams.get('cursor')??undefined),200));
        const text=await req.text(); if(text.length>500000) return withCors(req,json({error:'Library export is too large.'},413));
        let raw:unknown;try{raw=JSON.parse(text);}catch{return withCors(req,json({error:'Body is not valid JSON.'},400));}
        const books=parseLibrary(raw);if(typeof books==='string')return withCors(req,json({error:books},400));
        // Bound this export only. Other backup and CRM operations are unchanged.
        // The app waits longer than this deadline before retrying a lost response.
        const deadline=Date.now()+60000;
        const boundedNotion=new NotionClient(env.NOTION_TOKEN,(input,init)=>{
          const remaining=deadline-Date.now();
          if(remaining<=0)throw new Error('Library export reached its 60-second request deadline. Completed parts are kept.');
          return fetch(input,{...init,signal:AbortSignal.timeout(Math.min(15000,remaining))});
        },true);
        return withCors(req,json(await exportLibrary(boundedNotion,env.NOTION_LIBRARY_BOOKS_DB,env.NOTION_LIBRARY_TAKEAWAYS_DB,books),200));
      }catch(err){const retry=err instanceof NotionError?err.retryAfter:undefined;const r=json({error:err instanceof Error?err.message:'Library export failed.',...(retry?{retry_after:retry}:{})},retry?429:502);if(retry)r.headers.set('Retry-After',String(retry));return withCors(req,r);}
    }
    if (url.pathname.startsWith('/backup/')) return withCors(req, await handleBackup(req, env, url));
    // Android posts shared files here; the app's service worker normally intercepts it. If it is not active yet, just open the app.
    if (url.pathname === '/share-target') return Response.redirect(new URL('/', url).href, 303);
    // A contact card shared from "My QR": open to save the contact. Public, see vcard.ts.
    if (url.pathname === '/v') return req.method === 'GET' ? vcardResponse(url.searchParams.get('c'), url.searchParams.get('f') === '1') : json({ error: 'Use GET.' }, 405);
    // Everything else is a static file of the app.
    const API: Record<string, string> = { '/capture': 'POST', '/me': 'GET', '/me/update': 'POST', '/events': 'GET', '/events/create': 'POST', '/people/update': 'POST', '/people/delete': 'POST', '/people/duplicates': 'GET', '/people/merge': 'POST', '/people/list': 'GET', '/people/history': 'GET', '/status': 'GET', '/tasks/list': 'GET', '/tasks/create': 'POST', '/tasks/update': 'POST', '/tasks/delete': 'POST', '/companies/list': 'GET', '/companies/history': 'GET', '/companies/create': 'POST', '/companies/update': 'POST', '/interactions/create': 'POST', '/contacts/google': 'POST', '/scan/lookup': 'POST', '/export/interactions': 'GET', '/export/meetings': 'GET', '/meetings/upcoming': 'GET', '/meetings/notes': 'POST' };
    const method = API[url.pathname];
    if (!method) {
      return env.ASSETS ? env.ASSETS.fetch(req) : json({ error: 'Not found.' }, 404);
    }

    if (req.method !== method) return json({ error: `Use ${method}.` }, 405);

    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.CAPTURE_TOKEN || !token || !(await secretsMatch(token, env.CAPTURE_TOKEN))) {
      return json({ error: 'Wrong or missing access token.' }, 401);
    }

    if (url.pathname === '/me' || url.pathname === '/me/update') return handleMe(req, env, url.pathname);
    if (url.pathname === '/status') return json(await checkNotion(new NotionClient(env.NOTION_TOKEN), env), 200);
    if (url.pathname === '/interactions/create') return handleLog(req, env);
    if (url.pathname === '/contacts/google') return handleGoogleContact(req, env);
    if (url.pathname === '/scan/lookup') return handleLookup(req);
    if (url.pathname.startsWith('/export/')) return handleExport(env, url);
    if (url.pathname.startsWith('/meetings/')) return handleMeetings(req, env, url);
    if (url.pathname.startsWith('/companies/')) return handleCompanies(req, env, url);
    if (url.pathname.startsWith('/tasks/')) return handleTasks(req, env, url);
    if (url.pathname.startsWith('/people/')) return handlePeople(req, env, url);
    if (url.pathname === '/events' || url.pathname === '/events/create') return handleEvents(req, env, url.pathname);

    const length = Number(req.headers.get('Content-Length') ?? '0');
    if (length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413);
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400);
    }
    const parsed = parseRequest(body, new Date().toISOString().slice(0, 10));
    if (typeof parsed === 'string') return json({ error: parsed }, 400);

    const notion = new NotionClient(env.NOTION_TOKEN);
    let event: { id: string; name: string } | null = null;
    if (parsed.event_id) {
      if (!env.NOTION_EVENTS_DB) return json({ error: 'NOTION_EVENTS_DB is not set.' }, 503);
      try {
        event = await getEvent(notion, env.NOTION_EVENTS_DB, parsed.event_id);
      } catch (err) {
        if (err instanceof NotionError) return json({ error: err.message }, err.status);
        throw err;
      }
      if (!event) return json({ error: 'That event is not in your Events database. Pick it again.' }, 400);
    }
    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const model = env.MODEL || DEFAULT_MODEL;
    try {
      const { results, errors } = await runCapture(
        {
          extract: (r) => extractContacts(anthropic, model, r),
          notion,
          event,
          peopleDb: env.NOTION_PEOPLE_DB,
          companiesDb: env.NOTION_COMPANIES_DB,
          interactionsDb: env.NOTION_INTERACTIONS_DB,
        },
        parsed,
      );
      return json({ results, errors }, 200);
    } catch (err) {
      if (err instanceof ExtractionError || err instanceof NotionError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Unexpected error.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;



// One-way, non-deleting export. Personal notes, actions and topics in Notion are never written.
export interface LibraryBook { id: string; title: string; author: string; formats: string[]; status: string; notes: string; ideas: { key: string; text: string }[] }
export function parseLibrary(raw: unknown): LibraryBook[] | string {
  const books = (raw as any)?.books;
  if (!Array.isArray(books) || books.length !== 1) return 'Refresh Library while online, then retry the export. Send one book per request.';
  const ids = new Set<string>();
  const out: LibraryBook[] = [];
  for (const b of books) {
    if (!b || typeof b.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(b.id) || ids.has(b.id)) return 'Book IDs must be unique and valid.';
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 1000) return 'Each book needs a title of up to 1000 characters.';
    if (typeof b.author !== 'string' || b.author.length > 1000 || typeof b.notes !== 'string' || b.notes.length > 20000) return 'Author or app notes are too long.';
    if (!Array.isArray(b.formats) || b.formats.some((f: unknown) => !['ebook','audio','print'].includes(String(f)))) return 'Invalid format.';
    if (!['','Reading','Finished'].includes(b.status)) return 'Invalid reading status.';
    if (!Array.isArray(b.ideas) || b.ideas.length > 5) return 'Refresh Library while online, then retry the export. Send at most five takeaways per request.';
    const keys = new Set<string>();
    for (const idea of b.ideas) {
      if (!idea || typeof idea.key !== 'string' || !/^[a-zA-Z0-9_.:-]{1,180}$/.test(idea.key) || keys.has(idea.key) || typeof idea.text !== 'string' || !idea.text.trim() || idea.text.length > 10000) return 'Invalid takeaway.';
      keys.add(idea.key);
    }
    ids.add(b.id); out.push(b);
  }
  return out;
}
const rich = (s: string) => ({ rich_text: Array.from({length: Math.ceil(s.length / 1900)}, (_,i) => ({ type: 'text', text: { content: s.slice(i*1900,(i+1)*1900) } })) });
const title = (s: string) => ({ title: [{ type:'text', text:{content:s.slice(0,1000)} }] });
const same = (a: string, b: string) => a.replace(/-/g,'') === b.replace(/-/g,'');
function bookId(p: NotionPage) { return plain(p.properties['Library ID']); }
export async function exportLibrary(notion: NotionClient, booksDb: string, ideasDb: string, books: LibraryBook[]) {
  // Defend the request budget even when called outside the HTTP parser.
  const checked = parseLibrary({ books }); if (typeof checked === 'string') throw new Error(checked);
  // Validate both destinations before doing any writes.
  const [bd, td] = await Promise.all([notion.getDatabase(booksDb), notion.getDatabase(ideasDb)]);
  for (const k of ['Name','Author','Library ID','Library link','Format','Status','App notes']) if (!bd.properties[k]) throw new Error('Books schema is missing '+k+'.');
  for (const k of ['Name','Book','Idea','Source','Source key','Library link']) if (!td.properties[k]) throw new Error('Takeaways schema is missing '+k+'.');
  // Scope lookups to this book and these source keys, never scan entire collections.
  // Complete all pagination before writes, and cap it so even all 429 retries stay below 50 fetches.
  async function lookup(db: string, filter: unknown) {
    const rows: NotionPage[] = []; let cursor: string | undefined;
    for (let n = 0; n < 4; n++) {
      const page = await notion.queryPage(db, { filter, page_size:100, ...(cursor ? { start_cursor:cursor } : {}) });
      rows.push(...page.results);
      if (!page.has_more) return rows;
      if (!page.next_cursor) throw new Error('Incomplete Notion lookup. No changes made by this request.');
      cursor = page.next_cursor;
    }
    throw new Error('Too many matching Notion rows. No changes made by this request.');
  }
  const incoming = books[0];
  const oldBooks = await lookup(booksDb, {property:'Library ID',rich_text:{equals:incoming.id}});
  if (oldBooks.length > 1) throw new Error('Duplicate Library ID in Notion. No automatic merge was attempted.');
  const clauses:any[] = incoming.ideas.map(i=>({property:'Source key',rich_text:{equals:i.key}}));
  if (oldBooks[0] && incoming.ideas.length) clauses.push({and:[{property:'Book',relation:{contains:oldBooks[0].id}},{property:'Source',select:{equals:'Supplied guide'}},{property:'Source key',rich_text:{is_empty:true}}]});
  const oldIdeas = clauses.length ? await lookup(ideasDb, clauses.length===1?clauses[0]:{or:clauses}) : [];
  const counts = { books_created:0, books_updated:0, books_unchanged:0, takeaways_created:0, takeaways_updated:0, takeaways_unchanged:0 };
  for (const b of books) {
    const matches = oldBooks.filter(p=>bookId(p)===b.id);
    if (matches.length>1) throw new Error('Duplicate Library ID in Notion. No automatic merge was attempted.');
    const link = 'https://librarymh.github.io/library-app/#book='+b.id;
    const props = { Name:title(b.title), Author:rich(b.author), 'Library ID':rich(b.id), 'Library link':{url:link}, Format:{multi_select:b.formats.map(name=>({name}))}, Status:{select:b.status?{name:b.status}:null}, 'App notes':rich(b.notes) };
    let page = matches[0];
    if (page) {
      const p=page.properties;const unchanged=plain(p.Name)===b.title && plain(p.Author)===b.author && p['Library link']?.url===link && plain(p['App notes'])===b.notes && (p.Status?.select?.name??'')===b.status && JSON.stringify((p.Format?.multi_select??[]).map((f:any)=>f.name).sort())===JSON.stringify([...b.formats].sort());
      if(unchanged)counts.books_unchanged++;else{await notion.updatePage(page.id,props);counts.books_updated++;}
    }
    else { page=await notion.createPage(booksDb,props); oldBooks.push(page); counts.books_created++; }
    for (const idea of b.ideas) {
      const exact=oldIdeas.filter(p=>plain(p.properties['Source key'])===idea.key);
      // Adopt the initial imported row by book and exact idea, without replacing personal fields.
      const legacy=exact.length?exact:oldIdeas.filter(p=>!plain(p.properties['Source key']) && plain(p.properties.Source)==='Supplied guide' && plain(p.properties.Idea)===idea.text && (p.properties.Book?.relation??[]).some((r:any)=>same(r.id,page.id)));
      // Source is a select, so use its name for the initial imported rows too.
      const candidates=legacy.length?legacy:oldIdeas.filter(p=>!plain(p.properties['Source key']) && p.properties.Source?.select?.name==='Supplied guide' && plain(p.properties.Idea)===idea.text && (p.properties.Book?.relation??[]).some((r:any)=>same(r.id,page.id)));
      if(candidates.length>1) throw new Error('Duplicate takeaway in Notion. No automatic merge was attempted.');
      const ip={Name:title(idea.text), Book:{relation:[{id:page.id}]}, Idea:rich(idea.text), Source:{select:{name:'Supplied guide'}}, 'Source key':rich(idea.key), 'Library link':{url:link}};
      if(candidates[0]) {const p=candidates[0].properties;if(plain(p['Source key'])===idea.key && plain(p.Idea)===idea.text && plain(p.Name)===idea.text.slice(0,1000) && p.Source?.select?.name==='Supplied guide' && p['Library link']?.url===link)counts.takeaways_unchanged++;else{await notion.updatePage(candidates[0].id,ip);counts.takeaways_updated++;}}
      else {oldIdeas.push(await notion.createPage(ideasDb,ip));counts.takeaways_created++;}
    }
  }
  return counts;
}
