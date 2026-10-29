import Anthropic from '@anthropic-ai/sdk';
import { runCapture } from './capture';
import { DEFAULT_MODEL, ExtractionError, extractContacts } from './extract';
import { logInteraction, parseLog } from './interactions';
import { checkNotion } from './status';
import { companyHistory, createCompany, listCompanies, parseCompanyFields, parseCompanyUpdate, updateCompany } from './companies';
import { createTask, deleteTask, listTasks, parseTaskCreate, parseTaskUpdate, updateTask } from './tasks';
import { vcardResponse } from './vcard';
import { lookup, parseLookupRequest } from './lookup';
import { GoogleError, parseGoogleContact, saveToGoogle } from './google';
import { createEvent, getEvent, listEvents, parseNewEvent } from './events';
import { readMe, updateMeValue } from './me';
import { deletePerson, findDuplicates, listPeople, mergePeople, parsePatch, personHistory, updatePersonFields } from './people';
import { NotionClient, NotionError, pageTitle } from './notion';
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
      return json(await listTasks(deps, { since, cursor }), 200);
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') return json({ ok: true }, 200);
    // Android posts shared files here; the app's service worker normally intercepts it. If it is not active yet, just open the app.
    if (url.pathname === '/share-target') return Response.redirect(new URL('/', url).href, 303);
    // A contact card shared from "My QR": open to save the contact. Public, see vcard.ts.
    if (url.pathname === '/v') return req.method === 'GET' ? vcardResponse(url.searchParams.get('c'), url.searchParams.get('f') === '1') : json({ error: 'Use GET.' }, 405);
    // Everything else is a static file of the app.
    const API: Record<string, string> = { '/capture': 'POST', '/me': 'GET', '/me/update': 'POST', '/events': 'GET', '/events/create': 'POST', '/people/update': 'POST', '/people/delete': 'POST', '/people/duplicates': 'GET', '/people/merge': 'POST', '/people/list': 'GET', '/people/history': 'GET', '/status': 'GET', '/tasks/list': 'GET', '/tasks/create': 'POST', '/tasks/update': 'POST', '/tasks/delete': 'POST', '/companies/list': 'GET', '/companies/history': 'GET', '/companies/create': 'POST', '/companies/update': 'POST', '/interactions/create': 'POST', '/contacts/google': 'POST', '/scan/lookup': 'POST' };
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
