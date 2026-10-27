import type { CaptureRequest, CaptureResult, ExtractedContact } from './types';
import { createMeeting, createPerson, findOrCreateCompany, findPerson, updatePerson, NotionClient, pageTitle } from './notion';

export interface CaptureDeps {
  extract: (req: CaptureRequest) => Promise<ExtractedContact[]>;
  notion: NotionClient;
  peopleDb: string;
  companiesDb: string;
  interactionsDb: string;
  event?: { id: string; name: string } | null; // the event the people were met at (already checked)
}

function sourceLabel(req: CaptureRequest): string {
  if (req.images.length && req.text) return 'a photo and shared text';
  if (req.images.length) return 'a photo or screenshot';
  return 'shared text';
}

/** Read the contacts out of the images/text and write them to the CRM. Contacts are handled one by one so a failure on one does not lose the others. */
export async function runCapture(deps: CaptureDeps, req: CaptureRequest): Promise<{ results: CaptureResult[]; errors: string[] }> {
  const extracted = req.images.length || req.text ? await deps.extract(req) : [];
  // Each contact gets the note typed for its own photo; text and typed contacts use the general note.
  const photoNote = (c: ExtractedContact): string => {
    const img = (c.source_image ? req.images[c.source_image - 1] : undefined) ?? (req.images.length === 1 ? req.images[0] : undefined);
    return img?.note || req.note;
  };
  // With several photos and no way to tell which one a person came from, their notes are shown as a warning instead of guessed.
  const unattributed = (c: ExtractedContact): string[] => {
    const known = c.source_image && req.images[c.source_image - 1];
    if (known || req.images.length < 2) return [];
    return req.images.flatMap((im, i) => (im.note ? [`photo ${i + 1}: ${im.note}`] : []));
  };
  const contacts = [
    ...extracted.map((contact) => ({ contact, source: sourceLabel(req), note: photoNote(contact), lost: unattributed(contact) })),
    ...(req.manual ? [{ ...req.manual, note: req.note, lost: [] as string[] }] : []),
  ];
  const results: CaptureResult[] = [];
  const errors: string[] = [];

  for (const { contact: c, source, note, lost } of contacts) {
    try {
      const lookup = await findPerson(deps.notion, deps.peopleDb, c);
      const company = c.company ? await findOrCreateCompany(deps.notion, deps.companiesDb, c.company, c.website) : null;
      const input = {
        full_name: c.full_name,
        email: c.email,
        phone: c.phone,
        job_title: c.job_title,
        linkedin_url: c.linkedin_url,
        telegram_url: c.telegram_url ?? null,
        location: c.location,
        notes: c.notes,
        company,
        note,
        event: deps.event ?? null,
        today: req.today,
        source,
      };
      const outcome = lookup.match
        ? await updatePerson(deps.notion, lookup.match, input)
        : await createPerson(deps.notion, deps.peopleDb, input);

      const warnings = [...outcome.warnings];
      if (lost.length) warnings.push(`Could not tell which photo this person came from, so your photo notes were not added (${lost.join('; ')}).`);
      if (!lookup.match && lookup.similar.length) {
        const names = lookup.similar.map((p) => pageTitle(p, 'Name')).join(', ');
        warnings.push(`Possible duplicate of ${names}. Added as a new person; check and merge if it is the same one.`);
      }

      let interactionUrl: string | null = null;
      if (req.log_meeting) {
        const meeting = await createMeeting(deps.notion, deps.interactionsDb, outcome.page.id, c.full_name, note, req.today, deps.event ?? null);
        interactionUrl = meeting.url;
      }

      results.push({
        name: pageTitle(outcome.page, 'Name') || c.full_name,
        company: company?.name ?? null,
        action: outcome.action,
        needs_review: outcome.action === 'created',
        event: deps.event?.name ?? null,
        page_url: outcome.page.url,
        added: outcome.added,
        interaction_url: interactionUrl,
        warnings,
      });
    } catch (err) {
      errors.push(`${c.full_name}: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
  return { results, errors };
}
