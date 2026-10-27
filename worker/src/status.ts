import type { NotionClient } from './notion';
import type { Env } from './types';

export interface DbCheck {
  name: string; // what the app uses it for
  ok: boolean;
  title: string; // the database's name in Notion
  error: string;
}

/** Can the app's Notion connection see each database it needs? One call per database, nothing is read from them. */
export async function checkNotion(notion: NotionClient, env: Env): Promise<DbCheck[]> {
  const dbs: [string, string | undefined][] = [
    ['People', env.NOTION_PEOPLE_DB],
    ['Companies', env.NOTION_COMPANIES_DB],
    ['Interactions', env.NOTION_INTERACTIONS_DB],
    ['Events', env.NOTION_EVENTS_DB],
    ['Meetings', env.NOTION_MEETINGS_DB],
    ['My sharing details', env.NOTION_ME_DB],
    ['Tasks', env.NOTION_TASKS_DB],
  ];
  return Promise.all(
    dbs
      .filter(([, id]) => !!id)
      .map(async ([name, id]): Promise<DbCheck> => {
        try {
          const db = await notion.getDatabase(id!);
          return { name, ok: true, title: db.title?.map((t) => t.plain_text ?? '').join('') ?? '', error: '' };
        } catch (e) {
          return { name, ok: false, title: '', error: e instanceof Error ? e.message : 'Unknown error' };
        }
      }),
  );
}
