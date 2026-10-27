import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCapture, type CaptureDeps } from '../src/capture';
import { parseContacts } from '../src/extract';
import { NotionClient } from '../src/notion';
import type { CaptureRequest, ExtractedContact } from '../src/types';
import { FakeNotion, rich, title } from './fake-notion';

const PEOPLE = 'people-db';
const COMPANIES = 'companies-db';
const INTERACTIONS = 'interactions-db';

const contact = (over: Partial<ExtractedContact> = {}): ExtractedContact => ({
  full_name: 'Jane Doe',
  email: 'jane@acme.com',
  phone: '+34 600 111 222',
  job_title: 'Head of Sales',
  company: 'Acme Inc.',
  linkedin_url: 'https://www.linkedin.com/in/janedoe',
  website: null,
  location: null,
  notes: null,
  ...over,
});

const request = (over: Partial<CaptureRequest> = {}): CaptureRequest => ({
  images: [{ media_type: 'image/jpeg', data: 'AAAA' }],
  text: '',
  note: 'Met at MERGE Madrid',
  today: '2026-10-26',
  log_meeting: true,
  ...over,
});

let fake: FakeNotion;
const deps = (contacts: ExtractedContact[]): CaptureDeps => ({
  extract: async () => contacts,
  notion: new NotionClient('token', fake.fetch),
  peopleDb: PEOPLE,
  companiesDb: COMPANIES,
  interactionsDb: INTERACTIONS,
});

beforeEach(() => {
  fake = new FakeNotion();
});

describe('creating people', () => {
  it('creates a person, a company and an in-person interaction', async () => {
    const { results, errors } = await runCapture(deps([contact()]), request());
    expect(errors).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Jane Doe', company: 'Acme Inc.', action: 'created' });
    expect(results[0].added).toEqual(['Email', 'Phone', 'LinkedIn', 'Role', 'Company', 'How We Know Each Other']);

    const person = fake.rows.find((r) => r.db === PEOPLE)!;
    expect(person.properties.Email.email).toBe('jane@acme.com');
    expect(person.properties.Role.rich_text[0].text.content).toBe('Head of Sales');
    expect(person.properties['How We Know Each Other'].rich_text[0].text.content).toBe('Met at MERGE Madrid');
    expect(person.properties.Notes.rich_text[0].text.content).toContain('Added from a photo or screenshot on 2026-10-26');

    const company = fake.rows.find((r) => r.db === COMPANIES)!;
    expect(person.properties.Company.relation[0].id).toBe(company.id);

    expect(person.properties['Needs review'].checkbox).toBe(true);
    expect(results[0].needs_review).toBe(true);

    const meeting = fake.rows.find((r) => r.db === INTERACTIONS)!;
    expect(meeting.properties.Type.select.name).toBe('In person');
    expect(meeting.properties.Date.date.start).toBe('2026-10-26');
    expect(meeting.properties.People.relation[0].id).toBe(person.id);
  });

  it('reuses an existing company even when the legal form differs', async () => {
    const existing = fake.seed(COMPANIES, { Name: title('Acme') });
    await runCapture(deps([contact()]), request());
    expect(fake.rows.filter((r) => r.db === COMPANIES)).toHaveLength(1);
    expect(fake.rows.find((r) => r.db === PEOPLE)!.properties.Company.relation[0].id).toBe(existing.id);
  });

  it('skips the interaction when asked not to log a meeting', async () => {
    await runCapture(deps([contact()]), request({ log_meeting: false }));
    expect(fake.rows.some((r) => r.db === INTERACTIONS)).toBe(false);
  });

  it('handles several people in one photo', async () => {
    const { results } = await runCapture(
      deps([contact(), contact({ full_name: 'John Roe', email: 'john@acme.com', linkedin_url: null })]),
      request(),
    );
    expect(results.map((r) => r.name)).toEqual(['Jane Doe', 'John Roe']);
    expect(fake.rows.filter((r) => r.db === PEOPLE)).toHaveLength(2);
  });
});

describe('matching existing people', () => {
  it('finds a person by email and only fills empty fields', async () => {
    const existing = fake.seed(PEOPLE, {
      Name: title('Jane Doe'),
      Email: { email: 'jane@acme.com' },
      Phone: { phone_number: null },
      LinkedIn: { url: null },
      Role: rich(''),
      Company: { relation: [] },
      'How We Know Each Other': rich('Introduced by Sam'),
      Notes: rich('Old note'),
    });
    const { results } = await runCapture(deps([contact()]), request({ log_meeting: false }));
    expect(results[0]).toMatchObject({ action: 'updated', page_url: `https://notion.test/${existing.id}` });
    expect(results[0].added).toEqual(['Phone', 'LinkedIn', 'Role', 'Company', 'Notes']);
    expect(fake.rows.filter((r) => r.db === PEOPLE)).toHaveLength(1);
    expect(existing.properties['How We Know Each Other'].rich_text[0].text.content).toBe('Introduced by Sam');
    expect(existing.properties.Notes.rich_text[0].text.content).toBe(
      'Old note\n2026-10-26: Met at MERGE Madrid · Filled in: Phone, LinkedIn, Role, Company',
    );
  });

  it('never overwrites conflicting values, it warns instead', async () => {
    fake.seed(PEOPLE, {
      Name: title('Jane Doe'),
      Email: { email: 'jane@old.com' },
      Phone: { phone_number: '+34 699 000 000' },
      LinkedIn: { url: 'https://www.linkedin.com/in/janedoe' },
      Role: rich('CEO'),
      Company: { relation: [{ id: 'other' }] },
      'How We Know Each Other': rich('x'),
      Notes: rich(''),
    });
    const { results } = await runCapture(deps([contact({ email: 'jane@new.com' })]), request({ note: '', log_meeting: false }));
    // matched by LinkedIn, because the email differs
    expect(results[0].action).toBe('unchanged');
    expect(results[0].warnings).toHaveLength(4);
    expect(results[0].warnings.join(' ')).toContain('jane@old.com');
  });

  it('matches by name with accents and does not duplicate', async () => {
    fake.seed(PEOPLE, { Name: title('Benedikt Rütter'), Email: { email: null }, Notes: rich('') });
    const { results } = await runCapture(
      deps([contact({ full_name: 'Benedikt Rutter', email: 'b@bitgo.com', phone: null, job_title: null, company: null, linkedin_url: null })]),
      request({ log_meeting: false, note: '' }),
    );
    expect(results[0]).toMatchObject({ action: 'updated', added: ['Email', 'Notes'] });
    expect(fake.rows.filter((r) => r.db === PEOPLE)[0].properties.Notes.rich_text[0].text.content).toBe('2026-10-26: Filled in: Email');
    expect(fake.rows.filter((r) => r.db === PEOPLE)).toHaveLength(1);
  });

  it('adds a new person but flags a likely duplicate instead of merging', async () => {
    fake.seed(PEOPLE, { Name: title('Álvaro Durán Casares'), Email: { email: null } });
    const { results } = await runCapture(
      deps([contact({ full_name: 'Álvaro Durán', email: 'alvaro.duran@nebeus.com', linkedin_url: null, company: null })]),
      request({ log_meeting: false }),
    );
    expect(results[0].action).toBe('created');
    expect(results[0].warnings[0]).toContain('Possible duplicate of Álvaro Durán Casares');
    expect(fake.rows.filter((r) => r.db === PEOPLE)).toHaveLength(2);
  });
});

describe('review flag', () => {
  it('does not flag people who already existed', async () => {
    const existing = fake.seed(PEOPLE, { Name: title('Jane Doe'), Email: { email: 'jane@acme.com' }, Notes: rich('') });
    const { results } = await runCapture(deps([contact()]), request({ log_meeting: false }));
    expect(results[0].needs_review).toBe(false);
    expect(existing.properties['Needs review']).toBeUndefined();
  });
});

describe('Cloudflare runtime rules', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('calls the global fetch without a receiver, as Cloudflare requires (it throws "Illegal invocation" otherwise)', async () => {
    const strict = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      return fake.fetch(input, init);
    } as typeof fetch;
    vi.stubGlobal('fetch', strict);
    fake.seed(PEOPLE, { Name: title('Existing Person') });
    const notion = new NotionClient('token'); // default fetch, like the Worker uses
    await expect(notion.queryAll(PEOPLE)).resolves.toHaveLength(1);
  });
});

describe('large databases', () => {
  it('pages through every person when matching by name', async () => {
    for (let i = 0; i < 230; i++) fake.seed(PEOPLE, { Name: title(`Person Number${i}`), Email: { email: null } });
    fake.seed(PEOPLE, { Name: title('Zoë Zimmermann'), Email: { email: null }, Notes: rich('') });
    const { results } = await runCapture(
      deps([contact({ full_name: 'Zoe Zimmermann', email: 'zoe@z.com', phone: null, job_title: null, company: null, linkedin_url: null })]),
      request({ log_meeting: false, note: '' }),
    );
    expect(results[0]).toMatchObject({ action: 'updated', added: ['Email', 'Notes'] });
    expect(fake.rows.filter((r) => r.db === PEOPLE)).toHaveLength(231);
  });
});

describe('failure handling', () => {
  it('keeps going when one contact fails', async () => {
    const original = fake.fetch;
    fake.fetch = async (input, init) => {
      if (String(init?.body ?? '').includes('Bad Person')) return new Response('boom', { status: 500 });
      return original(input, init);
    };
    const { results, errors } = await runCapture(
      deps([contact({ full_name: 'Bad Person', email: 'bad@x.com' }), contact()]),
      request({ log_meeting: false }),
    );
    expect(results.map((r) => r.name)).toEqual(['Jane Doe']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Bad Person');
  });
});

describe('parseContacts', () => {
  it('cleans values and drops malformed entries', () => {
    const out = parseContacts({
      contacts: [
        {
          full_name: '  Jane  Doe ',
          email: 'JANE@ACME.COM',
          phone: 'tel:+34600111222',
          job_title: '',
          company: 'Acme',
          linkedin_url: 'https://linkedin.com/in/janedoe?x=1',
          website: 'acme.com',
          location: null,
          notes: null,
          source_image: 2,
        },
        { full_name: '', email: 'x@y.com' },
        null,
        'junk',
      ],
    });
    expect(out).toEqual([
      {
        full_name: 'Jane Doe',
        email: 'jane@acme.com',
        phone: '+34600111222',
        job_title: null,
        company: 'Acme',
        linkedin_url: 'https://www.linkedin.com/in/janedoe',
        website: 'https://acme.com',
        location: null,
        notes: null,
        source_image: 2,
      },
    ]);
  });
  it('rejects a response that is not a contacts object', () => {
    expect(() => parseContacts({})).toThrow();
    expect(() => parseContacts(null)).toThrow();
  });
});

describe('typed and scanned contacts', () => {
  const typed = (over: Partial<ExtractedContact> = {}, src: 'typed in' | 'a scanned QR code' = 'typed in'): CaptureRequest =>
    request({ images: [], text: '', manual: { contact: contact({ linkedin_url: null, ...over }), source: src } });
  const noExtract = (): CaptureDeps => ({
    ...deps([]),
    extract: async () => {
      throw new Error('the model must not be called for a typed contact');
    },
  });

  it('files a typed contact without calling the model, flagged for review, with the meeting only when asked', async () => {
    const { results, errors } = await runCapture(noExtract(), typed({}, 'typed in'));
    expect(errors).toEqual([]);
    expect(results[0]).toMatchObject({ name: 'Jane Doe', action: 'created', needs_review: true });
    const person = fake.rows.find((r) => r.db === PEOPLE)!;
    expect(person.properties.Notes.rich_text[0].text.content).toContain('Added from typed in');
    expect(fake.rows.filter((r) => r.db === INTERACTIONS)).toHaveLength(1);
    const again = await runCapture(noExtract(), { ...typed({ email: 'jane@acme.com' }), log_meeting: false });
    expect(again.results[0].action).not.toBe('created');
  });

  it('stores a Telegram profile and matches an existing person by it', async () => {
    const existing = fake.seed(PEOPLE, { Name: title('Someone Else'), Telegram: { url: 'https://t.me/janedoe' } });
    const res = await runCapture(noExtract(), { ...typed({ full_name: 'J. D.', email: null, phone: null, company: null, telegram_url: 'https://t.me/janedoe', job_title: null }), log_meeting: false });
    expect(res.results[0].page_url).toContain(existing.id);
    expect(fake.rows.filter((r) => r.db === PEOPLE)).toHaveLength(1);
  });

  it('adds Telegram to a new person', async () => {
    await runCapture(noExtract(), typed({ telegram_url: 'https://t.me/janedoe' }, 'a scanned QR code'));
    const p = fake.rows.find((r) => r.db === PEOPLE)!;
    expect(p.properties.Telegram.url).toBe('https://t.me/janedoe');
    expect(p.properties.Notes.rich_text[0].text.content).toContain('a scanned QR code');
  });
});

describe('events and per-contact notes', () => {
  const EVENT = { id: 'event-1', name: 'MERGE Madrid' };
  const evDeps = (contacts: ExtractedContact[]): CaptureDeps => ({ ...deps(contacts), event: EVENT });
  const sourced = (full_name: string, source_image: number | null, over: Partial<ExtractedContact> = {}) =>
    contact({ full_name, email: `${full_name.split(' ')[0].toLowerCase()}@x.com`, phone: null, linkedin_url: null, company: null, source_image, ...over });
  const photos = (...notes: string[]) => notes.map((note) => ({ media_type: 'image/jpeg' as const, data: 'AAAA', ...(note ? { note } : {}) }));
  const prop = (name: string, key: string) => fake.rows.find((r) => r.db === PEOPLE && r.properties.Name.title[0].text.content === name)!.properties[key];
  const noteOf = (name: string) => prop(name, 'Notes').rich_text[0].text.content as string;

  it('links a new person to the event, sets how you know them, and uses the event for the meeting', async () => {
    const res = await runCapture(evDeps([contact()]), request({ note: 'Wants an intro to the CFO' }));
    expect(res.results[0].event).toBe('MERGE Madrid');
    expect(prop('Jane Doe', 'Events').relation).toEqual([{ id: 'event-1' }]);
    expect(prop('Jane Doe', 'How We Know Each Other').rich_text[0].text.content).toBe('Met at MERGE Madrid');
    expect(noteOf('Jane Doe')).toContain('Added from');
    const meeting = fake.rows.find((r) => r.db === INTERACTIONS)!;
    expect(meeting.properties.Type.select.name).toBe('Event');
    expect(meeting.properties.Title.title[0].text.content).toBe('Met Jane Doe at MERGE Madrid');
    expect(meeting.properties.Summary.rich_text[0].text.content).toBe('Wants an intro to the CFO · Event: MERGE Madrid');
  });

  it('keeps the events a person already has and adds the new one', async () => {
    fake.seed(PEOPLE, { Name: title('Jane Doe'), Email: { email: 'jane@acme.com' }, Events: { relation: [{ id: 'old-event' }] }, Notes: rich('') });
    const res = await runCapture(evDeps([contact()]), request({ log_meeting: false }));
    expect(res.results[0].added).toContain('Event');
    expect(prop('Jane Doe', 'Events').relation).toEqual([{ id: 'old-event' }, { id: 'event-1' }]);
    const again = await runCapture(evDeps([contact()]), request({ log_meeting: false }));
    expect(again.results[0].added).not.toContain('Event');
    expect(prop('Jane Doe', 'Events').relation).toHaveLength(2);
  });

  it('gives every contact in a bulk run the note typed for its own photo', async () => {
    const people = [sourced('Ann One', 1), sourced('Bob Two', 2), sourced('Cy Three', 3)];
    await runCapture(evDeps(people), request({ images: photos('Knows the CTO', '', 'Follow up on pricing'), note: '', log_meeting: false }));
    expect(noteOf('Ann One')).toContain('Knows the CTO');
    expect(noteOf('Bob Two')).not.toContain('Knows the CTO');
    expect(noteOf('Cy Three')).toContain('Follow up on pricing');
    expect(noteOf('Cy Three')).not.toContain('Knows the CTO');
  });

  it('uses the one photo note when the model gives no image number, and the general note for text', async () => {
    await runCapture(deps([sourced('Dee Four', null)]), request({ images: photos('Met at the bar'), note: '', log_meeting: false }));
    expect(noteOf('Dee Four')).toContain('Met at the bar');
    await runCapture(deps([sourced('Eve Five', null)]), request({ images: [], text: 'sig', note: 'From her email', log_meeting: false }));
    expect(noteOf('Eve Five')).toContain('From her email');
  });

  it('without an event, the note still becomes How We Know Each Other (as before)', async () => {
    await runCapture(deps([contact()]), request({ note: 'Introduced by Andrei', log_meeting: false }));
    expect(prop('Jane Doe', 'How We Know Each Other').rich_text[0].text.content).toBe('Introduced by Andrei');
    expect(prop('Jane Doe', 'Events')).toBeUndefined();
  });

  it('does not guess when several photos have notes and the photo of a person is unknown', async () => {
    const res = await runCapture(deps([sourced('Fay Six', null)]), request({ images: photos('Knows the CTO', 'Pricing'), note: '', log_meeting: false }));
    expect(noteOf('Fay Six')).not.toContain('Knows the CTO');
    expect(res.results[0].warnings.join(' ')).toContain('photo 1: Knows the CTO; photo 2: Pricing');
  });

  it('gives new people a follow-up date but never changes an existing one', async () => {
    await runCapture(deps([contact()]), request({ follow_up_days: 7, today: '2026-10-28', log_meeting: false }));
    expect(prop('Jane Doe', 'Next Follow-up').date.start).toBe('2026-11-04');
    fake.rows.find((r) => r.db === PEOPLE)!.properties['Next Follow-up'] = { date: { start: '2026-12-24' } };
    await runCapture(deps([contact({ phone: '+34 611 000 000' })]), request({ follow_up_days: 7, today: '2026-10-29', log_meeting: false }));
    expect(prop('Jane Doe', 'Next Follow-up').date.start).toBe('2026-12-24');
    await runCapture(deps([contact({ full_name: 'No Reminder', email: 'n@r.com', linkedin_url: null })]), request({ log_meeting: false }));
    expect(prop('No Reminder', 'Next Follow-up')).toBeUndefined();
  });

  it('returns what Undo and "Save to phone contacts" need, and logs a meeting only once for a repeated send', async () => {
    const req = request({ log_meeting: true });
    const first = await runCapture(deps([contact()]), req);
    const r = first.results[0];
    expect(r.person_id).toBe(fake.rows.find((x) => x.db === PEOPLE)!.id);
    expect(r.company_created_id).toBe(fake.rows.find((x) => x.db === COMPANIES)!.id);
    expect(r.details).toEqual({ name: 'Jane Doe', company: 'Acme Inc.', role: 'Head of Sales', email: 'jane@acme.com', phone: '+34 600 111 222', linkedin: 'https://www.linkedin.com/in/janedoe', telegram: '' });
    const again = await runCapture(deps([contact()]), req);
    expect(again.results[0].company_created_id).toBeNull();
    expect(fake.rows.filter((x) => x.db === INTERACTIONS)).toHaveLength(1);
  });
});
