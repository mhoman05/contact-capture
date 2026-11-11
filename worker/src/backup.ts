// Shared backup of the phone apps (My Day, Racket Rankings, Pocket CRM, Gym) in one Notion database, "App backups".
// Each app compresses its own data, sends it here, and the service stores it as text in the body of a Notion page (one row per backup,
// the last few kept). The service never reads what is inside: the apps alone know their format. Restoring reads the newest row back.
import type { NotionClient, NotionPage } from './notion';

export const BACKUP_APPS = ['myday', 'rankings', 'crm', 'gym'] as const;
export type BackupApp = (typeof BACKUP_APPS)[number];
export const APP_NAMES: Record<BackupApp, string> = { myday: 'My Day', rankings: 'Racket Rankings', crm: 'Pocket CRM', gym: 'Gym' };
const MAX_DATA = 400_000; // characters, i.e. about 1.5 MB of text before compression; also keeps one Notion request under its size limit
const KEEP = 3; // backups kept per app; older ones go to Notion's trash
const CHUNK = 2000; // Notion's limit for one piece of text
const PER_BLOCK = 100; // pieces of text in one block (Notion's limit)

export interface SaveRequest { app: BackupApp; data: string; device: string }
export interface BackupInfo { app: BackupApp; name: string; at: string; size_kb: number; device: string }

export function isApp(v: unknown): v is BackupApp {
  return typeof v === 'string' && (BACKUP_APPS as readonly string[]).includes(v);
}

/** data is "gz:" or "raw:" followed by base64: that is all the service accepts, so nothing else can be stored through it. */
export function parseSave(raw: unknown): SaveRequest | string {
  if (!raw || typeof raw !== 'object') return 'Body must be a JSON object.';
  const o = raw as Record<string, unknown>;
  if (!isApp(o.app)) return `app must be one of: ${BACKUP_APPS.join(', ')}.`;
  if (typeof o.data !== 'string' || !/^(gz|raw):[A-Za-z0-9+/=]+$/.test(o.data)) return 'data must be "gz:" or "raw:" followed by base64 text.';
  if (o.data.length > MAX_DATA) return `This backup is too large (${Math.round(o.data.length / 1000)} thousand characters, the limit is ${MAX_DATA / 1000} thousand).`;
  const device = typeof o.device === 'string' ? o.device.replace(/[^\w .-]/g, '').slice(0, 60) : '';
  return { app: o.app, data: o.data, device };
}

const titleOf = (p: NotionPage) => (p.properties['App']?.title ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join('');
const infoOf = (p: NotionPage, app: BackupApp): BackupInfo => ({
  app,
  name: APP_NAMES[app],
  at: p.properties['Backed up']?.date?.start ?? p.created_time ?? '',
  size_kb: p.properties['Size KB']?.number ?? 0,
  device: (p.properties['Device']?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join(''),
});

const SORT_NEWEST = [{ timestamp: 'created_time', direction: 'descending' }];
async function versions(notion: NotionClient, dbId: string, app: BackupApp): Promise<NotionPage[]> {
  const res = await notion.queryPage(dbId, { filter: { property: 'App', title: { equals: APP_NAMES[app] } }, sorts: SORT_NEWEST, page_size: 20 });
  return res.results.filter((p) => titleOf(p) === APP_NAMES[app]);
}

export async function saveBackup(notion: NotionClient, dbId: string, req: SaveRequest, now = new Date()): Promise<BackupInfo> {
  const old = await versions(notion, dbId, req.app);
  const pieces: { type: 'text'; text: { content: string } }[] = [];
  for (let i = 0; i < req.data.length; i += CHUNK) pieces.push({ type: 'text', text: { content: req.data.slice(i, i + CHUNK) } });
  const children: unknown[] = [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: 'Backup data written by the app. Do not edit: restore it from inside the app.' } }] } }];
  for (let i = 0; i < pieces.length; i += PER_BLOCK) children.push({ object: 'block', type: 'code', code: { language: 'plain text', rich_text: pieces.slice(i, i + PER_BLOCK) } });
  const sizeKb = Math.max(1, Math.round(req.data.length / 1000));
  await notion.request<NotionPage>('POST', '/pages', {
    parent: { database_id: dbId },
    properties: {
      App: { title: [{ type: 'text', text: { content: APP_NAMES[req.app] } }] },
      'Backed up': { date: { start: now.toISOString() } },
      'Size KB': { number: sizeKb },
      Device: { rich_text: req.device ? [{ type: 'text', text: { content: req.device } }] : [] },
    },
    children,
  });
  for (const p of old.slice(KEEP - 1)) await notion.archivePage(p.id);
  return { app: req.app, name: APP_NAMES[req.app], at: now.toISOString(), size_kb: sizeKb, device: req.device };
}

/** The newest backup of an app, with its data, or null when there is none yet. */
export async function loadBackup(notion: NotionClient, dbId: string, app: BackupApp): Promise<(BackupInfo & { data: string }) | null> {
  const [latest] = await versions(notion, dbId, app);
  if (!latest) return null;
  let data = '';
  let cursor: string | undefined;
  do {
    const res = await notion.request<{ results: any[]; has_more: boolean; next_cursor: string | null }>('GET', `/blocks/${latest.id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const b of res.results) if (b.type === 'code') data += (b.code?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? '').join('');
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return { ...infoOf(latest, app), data };
}

/** When each app was last backed up (newest first per app). */
export async function listBackups(notion: NotionClient, dbId: string): Promise<BackupInfo[]> {
  const out: BackupInfo[] = [];
  for (const app of BACKUP_APPS) {
    const [latest] = await versions(notion, dbId, app);
    if (latest) out.push(infoOf(latest, app));
  }
  return out;
}

