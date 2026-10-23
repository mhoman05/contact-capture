import Anthropic from '@anthropic-ai/sdk';
import { runCapture } from './capture';
import { DEFAULT_MODEL, ExtractionError, extractContacts } from './extract';
import { NotionClient, NotionError } from './notion';
import type { CaptureImage, CaptureRequest, Env } from './types';

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 6;
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
    images.push({ media_type: i.media_type as CaptureImage['media_type'], data: i.data });
  }
  const text = typeof o.text === 'string' ? o.text.trim().slice(0, 8000) : '';
  if (!images.length && !text) return 'Send at least one image or some text.';
  const note = typeof o.note === 'string' ? o.note.trim().slice(0, 500) : '';
  const today = typeof o.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.today) ? o.today : fallbackToday;
  return { images, text, note, today, log_meeting: o.log_meeting !== false };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env);
    const url = new URL(req.url);

    if (url.pathname === '/health') return json({ ok: true }, 200, cors);
    // Android posts shared files here; the app's service worker normally intercepts it. If it is not active yet, just open the app.
    if (url.pathname === '/share-target') return Response.redirect(new URL('/', url).href, 303);
    // Everything else is a static file of the app.
    if (url.pathname !== '/capture') {
      return env.ASSETS ? env.ASSETS.fetch(req) : json({ error: 'Not found.' }, 404, cors);
    }

    if (req.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405, cors);
    if (!isAllowedOrigin(req, env)) return json({ error: 'Origin not allowed.' }, 403);

    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!env.CAPTURE_TOKEN || !token || !(await secretsMatch(token, env.CAPTURE_TOKEN))) {
      return json({ error: 'Wrong or missing access token.' }, 401, cors);
    }

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

    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const model = env.MODEL || DEFAULT_MODEL;
    try {
      const { results, errors } = await runCapture(
        {
          extract: (r) => extractContacts(anthropic, model, r),
          notion: new NotionClient(env.NOTION_TOKEN),
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
