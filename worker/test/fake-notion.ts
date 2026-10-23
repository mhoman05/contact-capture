// A tiny in-memory stand-in for the parts of the Notion API the worker uses.
type Props = Record<string, any>;
interface Row { id: string; db: string; properties: Props }

export class FakeNotion {
  rows: Row[] = [];
  calls: string[] = [];
  private n = 0;

  seed(db: string, properties: Props): Row {
    const row = { id: `page-${++this.n}`, db, properties };
    this.rows.push(row);
    return row;
  }

  private page(row: Row) {
    return { id: row.id, url: `https://notion.test/${row.id}`, properties: row.properties };
  }

  private matches(row: Row, filter: any): boolean {
    if (!filter) return true;
    const prop = row.properties[filter.property];
    if (filter.email) return (prop?.email ?? null) === filter.email.equals;
    if (filter.url) return (prop?.url ?? '').includes(filter.url.contains);
    if (filter.title) {
      const t = (prop?.title ?? []).map((x: any) => x.plain_text ?? x.text.content).join('');
      return t.toLowerCase().includes(String(filter.title.contains).toLowerCase());
    }
    throw new Error(`unsupported filter ${JSON.stringify(filter)}`);
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push(`${method} ${url.pathname}`);
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

    let m = url.pathname.match(/^\/v1\/databases\/([^/]+)\/query$/);
    if (m && method === 'POST') {
      const all = this.rows.filter((r) => r.db === m![1] && this.matches(r, body.filter));
      const start = body.start_cursor ? Number(body.start_cursor) : 0;
      const size = body.page_size ?? 100;
      const slice = all.slice(start, start + size);
      const more = start + size < all.length;
      return ok({ results: slice.map((r) => this.page(r)), has_more: more, next_cursor: more ? String(start + size) : null });
    }
    if (url.pathname === '/v1/pages' && method === 'POST') {
      const row = this.seed(body.parent.database_id, this.normalise(body.properties));
      return ok(this.page(row));
    }
    m = url.pathname.match(/^\/v1\/pages\/([^/]+)$/);
    if (m && method === 'PATCH') {
      const row = this.rows.find((r) => r.id === m![1])!;
      Object.assign(row.properties, this.normalise(body.properties));
      return ok(this.page(row));
    }
    return new Response('not found', { status: 404 });
  };

  /** Notion echoes rich text back with plain_text; mimic that so readers see what they would in production. */
  private normalise(props: Props): Props {
    const out: Props = {};
    for (const [k, v] of Object.entries(props)) {
      const copy = JSON.parse(JSON.stringify(v));
      for (const key of ['title', 'rich_text']) {
        if (copy[key]) copy[key] = copy[key].map((t: any) => ({ ...t, plain_text: t.text.content }));
      }
      out[k] = copy;
    }
    return out;
  }
}

export const title = (s: string) => ({ title: [{ plain_text: s, text: { content: s } }] });
export const rich = (s: string) => ({ rich_text: s ? [{ plain_text: s, text: { content: s } }] : [] });
