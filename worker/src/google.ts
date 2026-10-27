// "Save to phone contacts": the person goes into the owner's Google Contacts (People API), and Android syncs it to the phone.
import { fold } from './normalize';
import type { Env } from './types';

export interface GoogleContactIn {
  name: string;
  company?: string;
  role?: string;
  phone?: string;
  email?: string;
  linkedin?: string;
  telegram?: string;
  location?: string;
  note?: string;
}

export class GoogleError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Checks the request body; returns the contact or a message for the app. */
export function parseGoogleContact(body: unknown): GoogleContactIn | string {
  if (!body || typeof body !== 'object') return 'Send the details of the person.';
  const o = body as Record<string, unknown>;
  const name = str(o.name, 200);
  if (!name) return 'Send the name of the person.';
  return {
    name,
    company: str(o.company, 200),
    role: str(o.role, 200),
    phone: str(o.phone, 60),
    email: str(o.email, 200),
    linkedin: str(o.linkedin, 500),
    telegram: str(o.telegram, 500),
    location: str(o.location, 300),
    note: str(o.note, 2000),
  };
}

export const googleConfigured = (env: Env): boolean => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);

let cached: { token: string; until: number } | null = null;
let warmed = false;

/** For tests: forget the saved access token and the search warm-up. */
export function resetGoogleState(): void {
  cached = null;
  warmed = false;
}

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
      refresh_token: env.GOOGLE_REFRESH_TOKEN ?? '',
      grant_type: 'refresh_token',
    }),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) {
    const why = j.error === 'invalid_grant' ? 'Google no longer accepts the saved permission. Repeat the Google step in the setup guide and replace GOOGLE_REFRESH_TOKEN.' : `Google refused the saved permission (${j.error ?? res.status}).`;
    throw new GoogleError(why, 502);
  }
  cached = { token: j.access_token, until: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}

async function people(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://people.googleapis.com/v1/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = j?.error?.message ?? `status ${res.status}`;
    if (res.status === 403 || res.status === 401) throw new GoogleError(`Google Contacts said no (${msg}). Check that the People API is enabled and the permission includes contacts.`, 502);
    throw new GoogleError(`Google Contacts failed (${msg}).`, 502);
  }
  return j;
}

const digits = (s: string) => s.replace(/\D/g, '');

/** True when the Google contact is the same person: same email, same phone (last 9 digits) or the same name. */
function sameContact(g: any, c: GoogleContactIn): boolean {
  const emails = (g.emailAddresses ?? []).map((e: any) => String(e.value ?? '').toLowerCase());
  if (c.email && emails.includes(c.email.toLowerCase())) return true;
  const phones = (g.phoneNumbers ?? []).map((p: any) => digits(String(p.value ?? '')).slice(-9));
  const mine = digits(c.phone ?? '').slice(-9);
  if (mine.length >= 7 && phones.includes(mine)) return true;
  const names = (g.names ?? []).map((n: any) => fold(String(n.displayName ?? '')));
  return names.includes(fold(c.name));
}

async function findExisting(token: string, c: GoogleContactIn): Promise<boolean> {
  if (!warmed) {
    await people(token, 'people:searchContacts?query=&readMask=names'); // Google asks for an empty search first, to warm its search index
    warmed = true;
  }
  for (const q of [c.email, digits(c.phone ?? ''), c.name]) {
    if (!q) continue;
    const j = await people(token, `people:searchContacts?query=${encodeURIComponent(q)}&pageSize=10&readMask=names,emailAddresses,phoneNumbers`);
    if ((j.results ?? []).some((r: any) => sameContact(r.person ?? {}, c))) return true;
  }
  return false;
}

/** The People API body for a new contact. */
export function googleBody(c: GoogleContactIn): Record<string, unknown> {
  const parts = c.name.split(/\s+/);
  const familyName = parts.length > 1 ? parts[parts.length - 1] : '';
  const givenName = parts.length > 1 ? parts.slice(0, -1).join(' ') : c.name;
  const body: Record<string, unknown> = { names: [{ givenName, ...(familyName ? { familyName } : {}) }] };
  if (c.company || c.role) body.organizations = [{ ...(c.company ? { name: c.company } : {}), ...(c.role ? { title: c.role } : {}) }];
  if (c.phone) body.phoneNumbers = [{ value: c.phone, type: 'mobile' }];
  if (c.email) body.emailAddresses = [{ value: c.email, type: 'work' }];
  const urls = [c.linkedin && { value: c.linkedin, type: 'profile' }, c.telegram && { value: c.telegram, type: 'other' }].filter(Boolean);
  if (urls.length) body.urls = urls;
  if (c.location) body.addresses = [{ formattedValue: c.location }];
  if (c.note) body.biographies = [{ value: c.note, contentType: 'TEXT_PLAIN' }];
  return body;
}

/** Adds the person to Google Contacts unless somebody with the same email, phone or name is already there. */
export async function saveToGoogle(env: Env, c: GoogleContactIn): Promise<{ status: 'created' | 'exists' }> {
  if (!googleConfigured(env)) throw new GoogleError('Google Contacts is not set up yet.', 503);
  const token = await accessToken(env);
  if (await findExisting(token, c)) return { status: 'exists' };
  await people(token, 'people:createContact', { method: 'POST', body: JSON.stringify(googleBody(c)) });
  return { status: 'created' };
}
