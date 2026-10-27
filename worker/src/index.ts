import Anthropic from '@anthropic-ai/sdk';
import { runCapture } from './capture';
import { DEFAULT_MODEL, ExtractionError, extractContacts } from './extract';
import { createEvent, getEvent, listEvents, parseNewEvent } from './events';
import { readMe, updateMeValue } from './me';
import { NotionClient, NotionError } from './notion';
import { cleanEmail, cleanLinkedInLink, cleanPhone, cleanTelegram, cleanWebsite, nonEmpty } from './normalize';
import type { CaptureImage, CaptureRequest, Env, ManualContact } from './types';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 12; // a bulk run after a conference
const MAX_IMAGE_B64 = 6 * 1024 * 1024; // base64 characters per image (the app downsizes to well under this)
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** ALLOWED_ORIGIN may list several origins, comma separated (for example a personal and an organisation Pages address). */
export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGIN ?? '').split(',').map((o) => o.trim()).filter(Boolean);
}

function isAllowedOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (!origin) return true; // not a browser request; the access token still decides
  return origin === new URL(req.url).origin || allowedOrigins(env).includes(origin);
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || origin === new URL(req.url).origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
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
  return { images, text, note, today, log_meeting, ...(manual ? { manual } : {}), ...(eventId ? { event_id: eventId } : {}) };
}

/** The details you may share about yourself (Notion database "My sharing details"). */
async function handleMe(req: Request, env: Env, path: string, cors: Record<string, string>): Promise<Response> {
  if (!env.NOTION_ME_DB) return json({ error: 'NOTION_ME_DB is not set.' }, 503, cors);
  const notion = new NotionClient(env.NOTION_TOKEN);
  try {
    if (path === '/me') return json({ items: await readMe(notion, env.NOTION_ME_DB) }, 200, cors);
    const raw = await req.text();
    if (raw.length > 10_000) return json({ error: 'Request too large.' }, 413, cors);
    let body: { id?: unknown; value?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400, cors);
    }
    if (typeof body.id !== 'string' || !/^[0-9a-z-]{6,40}$/i.test(body.id) || typeof body.value !== 'string') {
      return json({ error: 'Send {"id": "<row id>", "value": "<text>"}.' }, 400, cors);
    }
    const item = await updateMeValue(notion, env.NOTION_ME_DB, body.id, body.value.trim().slice(0, 1900));
    return item ? json({ item }, 200, cors) : json({ error: 'That row is not in My sharing details.' }, 404, cors);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status, cors);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500, cors);
  }
}

/** The Events database: list the events to choose from, or create a new one. */
async function handleEvents(req: Request, env: Env, path: string, cors: Record<string, string>): Promise<Response> {
  if (!env.NOTION_EVENTS_DB) return json({ error: 'NOTION_EVENTS_DB is not set.' }, 503, cors);
  const notion = new NotionClient(env.NOTION_TOKEN);
  try {
    if (path === '/events') return json({ events: await listEvents(notion, env.NOTION_EVENTS_DB) }, 200, cors);
    const raw = await req.text();
    if (raw.length > 10_000) return json({ error: 'Request too large.' }, 413, cors);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400, cors);
    }
    const parsed = parseNewEvent(body, new Date().toISOString().slice(0, 10));
    if (typeof parsed === 'string') return json({ error: parsed }, 400, cors);
    return json({ event: await createEvent(notion, env.NOTION_EVENTS_DB, parsed) }, 200, cors);
  } catch (err) {
    if (err instanceof NotionError) return json({ error: err.message }, err.status, cors);
    console.error(err);
    return json({ error: 'Unexpected error.' }, 500, cors);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);
    const url = new URL(req.url);

    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    // Android posts shared files here; the app's service worker normally intercepts it. If it is not active yet, just open the app.
    if (url.pathname === '/share-target') return Response.redirect(new URL('/', url).href, 303);
    // Everything else is a static file of the app.
    const API: Record<string, string> = { '/capture': 'POST', '/me': 'GET', '/me/update': 'POST', '/events': 'GET', '/events/create': 'POST' };
    const method = API[url.pathname];
    if (!method) {
      return env.ASSETS ? env.ASSETS.fetch(req) : json({ error: 'Not found.' }, 404, cors);
    }

    if (req.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
    if (req.method !== method) return json({ error: `Use ${method}.` }, 405, cors);
    if (!isAllowedOrigin(req, env)) return json({ error: 'Origin not allowed.' }, 403);

    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.CAPTURE_TOKEN || !token || !(await secretsMatch(token, env.CAPTURE_TOKEN))) {
      return json({ error: 'Wrong or missing access token.' }, 401, cors);
    }

    if (url.pathname === '/me' || url.pathname === '/me/update') return handleMe(req, env, url.pathname, cors);
    if (url.pathname === '/events' || url.pathname === '/events/create') return handleEvents(req, env, url.pathname, cors);

    const length = Number(req.headers.get('Content-Length') ?? '0');
    if (length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413, cors);
    const raw = await req.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'Request too large.' }, 413, cors);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: 'Body is not valid JSON.' }, 400, cors);
    }
    const parsed = parseRequest(body, new Date().toISOString().slice(0, 10));
    if (typeof parsed === 'string') return json({ error: parsed }, 400, cors);

    const notion = new NotionClient(env.NOTION_TOKEN);
    let event: { id: string; name: string } | null = null;
    if (parsed.event_id) {
      if (!env.NOTION_EVENTS_DB) return json({ error: 'NOTION_EVENTS_DB is not set.' }, 503, cors);
      try {
        event = await getEvent(notion, env.NOTION_EVENTS_DB, parsed.event_id);
      } catch (err) {
        if (err instanceof NotionError) return json({ error: err.message }, err.status, cors);
        throw err;
      }
      if (!event) return json({ error: 'That event is not in your Events database. Pick it again.' }, 400, cors);
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
      return json({ results, errors }, 200, cors);
    } catch (err) {
      if (err instanceof ExtractionError || err instanceof NotionError) return json({ error: err.message }, err.status, cors);
      console.error(err);
      return json({ error: 'Unexpected error.' }, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;
