// Shared backup of the phone apps (My Day, Racket Rankings, Pocket CRM, Gym) in one Notion database, "App backups".
// Each app compresses its own data, sends it here, and the service stores it as text in the body of a Notion page (one row per backup,
// the last few kept). The service never reads what is inside: the apps alone know their format. Restoring reads the newest row back.
import { NotionClient, NotionPage, plain } from "./notion";

export const BACKUP_APPS = [
  "myday",
  "rankings",
  "crm",
  "gym",
  "library",
] as const;
export type BackupApp = (typeof BACKUP_APPS)[number];
export const APP_NAMES: Record<BackupApp, string> = {
  myday: "My Day",
  rankings: "Racket Rankings",
  crm: "Pocket CRM",
  gym: "Gym",
  library: "Library",
};
const MAX_DATA = 400_000; // characters, i.e. about 1.5 MB of text before compression; also keeps one Notion request under its size limit
const PRESERVED_LIBRARY_BACKUP = "415e528fadf881a7abb0cf24a21aa42e";
const protectedLibrary = (p: NotionPage) => p.id.replace(/-/g, "") === PRESERVED_LIBRARY_BACKUP;
const KEEP = 3; // backups kept per app; older ones go to Notion's trash
const CHUNK = 2000; // Notion's limit for one piece of text
const PER_BLOCK = 100; // pieces of text in one block (Notion's limit)

export interface SaveRequest {
  app: BackupApp;
  data: string;
  device: string;
}
export interface BackupInfo {
  app: BackupApp;
  name: string;
  at: string;
  size_kb: number;
  device: string;
}

export function isApp(v: unknown): v is BackupApp {
  return (
    typeof v === "string" && (BACKUP_APPS as readonly string[]).includes(v)
  );
}

/** data is "gz:" or "raw:" followed by base64: that is all the service accepts, so nothing else can be stored through it. */
export function parseSave(raw: unknown): SaveRequest | string {
  if (!raw || typeof raw !== "object") return "Body must be a JSON object.";
  const o = raw as Record<string, unknown>;
  if (!isApp(o.app)) return `app must be one of: ${BACKUP_APPS.join(", ")}.`;
  if (typeof o.data !== "string" || !/^(gz|raw):[A-Za-z0-9+/=]+$/.test(o.data))
    return 'data must be "gz:" or "raw:" followed by base64 text.';
  if (o.data.length > MAX_DATA)
    return `This backup is too large (${Math.round(o.data.length / 1000)} thousand characters, the limit is ${MAX_DATA / 1000} thousand).`;
  const device =
    typeof o.device === "string"
      ? o.device.replace(/[^\w .-]/g, "").slice(0, 60)
      : "";
  return { app: o.app, data: o.data, device };
}

const titleOf = (p: NotionPage) =>
  (p.properties["App"]?.title ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
const infoOf = (p: NotionPage, app: BackupApp): BackupInfo => ({
  app,
  name: APP_NAMES[app],
  at: p.properties["Backed up"]?.date?.start ?? p.created_time ?? "",
  size_kb: p.properties["Size KB"]?.number ?? 0,
  device: (p.properties["Device"]?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join(""),
});

const SORT_NEWEST = [{ timestamp: "created_time", direction: "descending" }];
async function versions(
  notion: NotionClient,
  dbId: string,
  app: BackupApp,
): Promise<NotionPage[]> {
  const res = await notion.queryPage(dbId, {
    filter: { property: "App", title: { equals: APP_NAMES[app] } },
    sorts:
      app === "library"
        ? [{ property: "Backed up", direction: "descending" }]
        : SORT_NEWEST,
    page_size: 20,
  });
  return res.results.filter((p) => titleOf(p) === APP_NAMES[app]);
}

export async function saveBackup(
  notion: NotionClient,
  dbId: string,
  req: SaveRequest,
  now = new Date(),
): Promise<BackupInfo> {
  const old = await versions(notion, dbId, req.app);
  const pieces: { type: "text"; text: { content: string } }[] = [];
  for (let i = 0; i < req.data.length; i += CHUNK)
    pieces.push({
      type: "text",
      text: { content: req.data.slice(i, i + CHUNK) },
    });
  const children: unknown[] = [
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content:
                "Backup data written by the app. Do not edit: restore it from inside the app.",
            },
          },
        ],
      },
    },
  ];
  for (let i = 0; i < pieces.length; i += PER_BLOCK)
    children.push({
      object: "block",
      type: "code",
      code: {
        language: "plain text",
        rich_text: pieces.slice(i, i + PER_BLOCK),
      },
    });
  const sizeKb = Math.max(1, Math.round(req.data.length / 1000));
  await notion.request<NotionPage>("POST", "/pages", {
    parent: { database_id: dbId },
    properties: {
      App: { title: [{ type: "text", text: { content: APP_NAMES[req.app] } }] },
      "Backed up": { date: { start: now.toISOString() } },
      "Size KB": { number: sizeKb },
      Device: {
        rich_text: req.device
          ? [{ type: "text", text: { content: req.device } }]
          : [],
      },
    },
    children,
  });
  for (const p of old.filter(p => req.app !== "library" || !protectedLibrary(p)).slice(KEEP - 1)) await notion.archivePage(p.id);
  return {
    app: req.app,
    name: APP_NAMES[req.app],
    at: now.toISOString(),
    size_kb: sizeKb,
    device: req.device,
  };
}

/** The newest backup of an app, with its data, or null when there is none yet. */
export async function loadBackup(
  notion: NotionClient,
  dbId: string,
  app: BackupApp,
): Promise<(BackupInfo & { data: string }) | null> {
  const [latest] = await versions(notion, dbId, app);
  if (!latest) return null;
  let data = "";
  const codeValues: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion.request<{
      results: any[];
      has_more: boolean;
      next_cursor: string | null;
    }>(
      "GET",
      `/blocks/${latest.id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const b of res.results)
      if (b.type === "code") {
        const value = (b.code?.rich_text ?? [])
          .map((t: any) => t.plain_text ?? t.text?.content ?? "")
          .join("");
        codeValues.push(value);
        data += value;
      }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  if (app === "library") data = (await decodeLibraryUpload(codeValues)) ?? data;
  return { ...infoOf(latest, app), data };
}

/** When each app was last backed up (newest first per app). */
export async function listBackups(
  notion: NotionClient,
  dbId: string,
): Promise<BackupInfo[]> {
  const out: BackupInfo[] = [];
  for (const app of BACKUP_APPS) {
    const [latest] = await versions(notion, dbId, app);
    if (latest) out.push(infoOf(latest, app));
  }
  return out;
}

// Versioned, bounded Library uploads and read-only export preflight.

export const PART = 160000,
  MAX_PARTS = 32;
export const digest = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const rt = (s: string) =>
  Array.from({ length: Math.ceil(s.length / 1900) }, (_, i) => ({
    type: "text",
    text: { content: s.slice(i * 1900, (i + 1) * 1900) },
  }));
const code = (s: string) => ({
  object: "block",
  type: "code",
  code: { language: "plain text", rich_text: rt(s) },
});
const prefix = "library-upload-v2:";
const uploadTitleOf = (p: any) => plain(p.properties.App);
async function read(n: NotionClient, db: string, id: string) {
  const p = await n.getPage(id);
  if (
    (p.parent?.database_id ?? "").replace(/-/g, "") !== db.replace(/-/g, "") ||
    !/^Library(?: upload [a-f0-9]{64})?$/.test(uploadTitleOf(p))
  )
    throw Error("Not a Library upload in this backup collection.");
  const r = await n.request<any>(
    "GET",
    "/blocks/" + id + "/children?page_size=100",
  );
  if (r.has_more)
    throw Error("Upload has too many blocks. Keep the current backup.");
  const values = r.results
    .filter((b: any) => b.type === "code")
    .map((b: any) => plain(b.code));
  if (!values[0]?.startsWith(prefix))
    throw Error("Not a versioned Library upload.");
  const meta = JSON.parse(values[0].slice(prefix.length));
  validate(meta);
  const chunks = new Map<number, string>();
  for (const text of values.slice(1)) {
    const c = JSON.parse(text);
    if (
      !Number.isInteger(c.i) ||
      c.i < 0 ||
      c.i >= meta.count ||
      typeof c.data !== "string" ||
      c.data.length !== Math.min(PART, meta.length - c.i * PART) ||
      (await digest(c.data)) !== c.hash
    )
      throw Error("Invalid stored backup chunk.");
    if (chunks.has(c.i) && chunks.get(c.i) !== c.data)
      throw Error("Conflicting backup chunks.");
    chunks.set(c.i, c.data);
  }
  return { p, meta, chunks };
}
function validate(m: any) {
  if (
    !m ||
    !/^([a-f0-9]{64})$/.test(m.hash) ||
    !Number.isInteger(m.length) ||
    m.length < 1 ||
    m.length > PART * MAX_PARTS ||
    m.count !== Math.ceil(m.length / PART)
  )
    throw Error("Invalid backup manifest.");
}
export async function libraryUpload(
  n: NotionClient,
  db: string,
  action: string,
  body: any,
) {
  if (action === "start") {
    validate(body);
    const name = "Library upload " + body.hash;
    const found = await n.queryPage(db, {
      filter: { property: "App", title: { equals: name } },
      page_size: 20,
    });
    if (found.has_more) throw Error("Too many matching uploads.");
    if (found.results.length) {
      const r = await read(n, db, found.results[0].id);
      return { id: r.p.id, received: [...r.chunks.keys()] };
    }
    const meta = {
      hash: body.hash,
      length: body.length,
      count: body.count,
      device: String(body.device ?? "")
        .replace(/[^\w .-]/g, "")
        .slice(0, 60),
    };
    const p = await n.request<any>("POST", "/pages", {
      parent: { database_id: db },
      properties: {
        App: { title: rt(name) },
        "Backed up": { date: { start: new Date().toISOString() } },
        "Size KB": { number: Math.ceil(body.length / 1000) },
        Device: { rich_text: rt(meta.device) },
      },
      children: [code(prefix + JSON.stringify(meta))],
    });
    return { id: p.id, received: [] };
  }
  if (typeof body.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(body.id))
    throw Error("Invalid upload ID.");
  const r = await read(n, db, body.id);
  if (action === "part") {
    if (uploadTitleOf(r.p) === "Library") return { id: r.p.id, complete: true };
    const i = body.i,
      data = body.data;
    if (
      !Number.isInteger(i) ||
      i < 0 ||
      i >= r.meta.count ||
      typeof data !== "string" ||
      data.length !== Math.min(PART, r.meta.length - i * PART) ||
      !/^[A-Za-z0-9+/:=]+$/.test(data)
    )
      throw Error("Invalid backup part.");
    if (r.chunks.has(i)) {
      if (r.chunks.get(i) !== data)
        throw Error("Backup part conflicts with previous content.");
      return { id: r.p.id, received: i };
    }
    await n.request("PATCH", "/blocks/" + r.p.id + "/children", {
      children: [code(JSON.stringify({ i, hash: await digest(data), data }))],
    });
    return { id: r.p.id, received: i };
  }
  if (action === "commit") {
    const data = await assemble(r.meta, r.chunks);
    if (!/^(gz|raw):[A-Za-z0-9+/=]+$/.test(data))
      throw Error("Invalid backup content.");
    if (uploadTitleOf(r.p) !== "Library")
      await n.updatePage(r.p.id, {
        App: { title: rt("Library") },
        "Backed up": { date: { start: new Date().toISOString() } },
      });
    // The explicitly preserved old snapshot does not count against future retention.
    // Exact Library titles include only completed snapshots, never incomplete uploads.
    const old = await n.queryPage(db, {
      filter: { property: "App", title: { equals: "Library" } },
      sorts: [{ property: "Backed up", direction: "descending" }],
      page_size: 100,
    });
    if (old.has_more) throw Error("Backup saved; retention needs a separate review. No snapshots removed.");
    for (const p of old.results.filter(p => !protectedLibrary(p)).slice(KEEP))
      await n.archivePage(p.id);
    return {
      backup: {
        app: "library",
        name: "Library",
        at: new Date().toISOString(),
        size_kb: Math.ceil(data.length / 1000),
        device: r.meta.device,
      },
      hash: r.meta.hash,
    };
  }
  throw Error("Unknown upload operation.");
}
async function assemble(meta: any, chunks: Map<number, string>) {
  if (chunks.size !== meta.count)
    throw Error("Backup upload is incomplete. Previous backups are unchanged.");
  const data = Array.from(
    { length: meta.count },
    (_, i) => chunks.get(i) ?? "",
  ).join("");
  if (data.length !== meta.length || (await digest(data)) !== meta.hash)
    throw Error("Backup verification failed. Previous backups are unchanged.");
  return data;
}
export async function decodeLibraryUpload(values: string[]) {
  if (!values[0]?.startsWith(prefix)) return null;
  const meta = JSON.parse(values[0].slice(prefix.length));
  validate(meta);
  const chunks = new Map<number, string>();
  for (const text of values.slice(1)) {
    const c = JSON.parse(text);
    if (chunks.has(c.i) && chunks.get(c.i) !== c.data)
      throw Error("Conflicting backup chunks.");
    chunks.set(c.i, c.data);
  }
  return assemble(meta, chunks);
}

export const bookShape = (p: any) => [
  plain(p.Name),
  plain(p.Author),
  [...(p.Format?.multi_select ?? [])].map((f: any) => f.name).sort(),
  p.Status?.select?.name ?? "",
  plain(p["App notes"]),
];
export const ideaShape = (p: any) => [
  plain(p.Idea),
  p.Book?.relation?.[0]?.id ?? "",
  p.Source?.select?.name ?? "",
  plain(p.Name),
];
export async function libraryStatus(
  n: NotionClient,
  booksDb: string,
  ideasDb: string,
  kind: string,
  cursor?: string,
) {
  if (!["books", "ideas"].includes(kind)) throw Error("Invalid status kind.");
  if (cursor && (cursor.length > 2048 || /[\u0000-\u001f]/.test(cursor)))
    throw Error("Invalid status cursor.");
  const r = await n.queryPage(kind === "books" ? booksDb : ideasDb, {
    page_size: 100,
    ...(cursor ? { start_cursor: cursor } : {}),
  });
  return {
    kind,
    rows: await Promise.all(
      r.results.map(async (p) => ({
        id: p.id,
        key: plain(
          p.properties[kind === "books" ? "Library ID" : "Source key"],
        ),
        hash: await digest(
          JSON.stringify(
            kind === "books"
              ? bookShape(p.properties)
              : ideaShape(p.properties),
          ),
        ),
        link: p.properties["Library link"]?.url ?? "",
      })),
    ),
    next_cursor: r.has_more ? r.next_cursor : null,
  };
}
