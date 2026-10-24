import type { CaptureRequest, CaptureResult, ExtractedContact } from './types';
import { createMeeting, createPerson, findOrCreateCompany, findPerson, updatePerson, NotionClient, pageTitle } from './notion';

export interface CaptureDeps {
  extract: (req: CaptureRequest) => Promise<ExtractedContact[]>;
  notion: NotionClient;
  peopleDb: string;
  companiesDb: string;
  interactionsDb: string;
}

function sourceLabel(req: CaptureRequest): string {
  if (req.images.length && req.text) return 'a photo and shared text';
  if (req.images.length) return 'a photo or screenshot';
  return 'shared text';
}

/** Read the contacts out of the images/text and write them to the CRM. Contacts are handled one by one so a failure on one does not lose the others. */
export async function runCapture(deps: CaptureDeps, req: CaptureRequest): Promise<{ results: CaptureResult[]; errors: string[] }> {
  const contacts = await deps.extract(req);
  const results: CaptureResult[] = [];
  const errors: string[] = [];

  for (const c of contacts) {
    try {
      const lookup = await findPerson(deps.notion, deps.peopleDb, c);
      const company = c.company ? await findOrCreateCompany(deps.notion, deps.companiesDb, c.company, c.website) : null;
      const input = {
        full_name: c.full_name,
        email: c.email,
        phone: c.phone,
        job_title: c.job_title,
        linkedin_url: c.linkedin_url,
        location: c.location,
        notes: c.notes,
        company,
        note: req.note,
        today: req.today,
        source: sourceLabel(req),
      };
      const outcome = lookup.match
        ? await updatePerson(deps.notion, lookup.match, input)
        : await createPerson(deps.notion, deps.peopleDb, input);

      const warnings = [...outcome.warnings];
      if (!lookup.match && lookup.similar.length) {
        const names = lookup.similar.map((p) => pageTitle(p, 'Name')).join(', ');
        warnings.push(`Possible duplicate of ${names}. Added as a new person; check and merge if it is the same one.`);
      }

      let interactionUrl: string | null = null;
      if (req.log_meeting) {
        const meeting = await createMeeting(deps.notion, deps.interactionsDb, outcome.page.id, c.full_name, req.note, req.today);
        interactionUrl = meeting.url;
      }

      results.push({
        name: pageTitle(outcome.page, 'Name') || c.full_name,
        company: company?.name ?? null,
        action: outcome.action,
        needs_review: outcome.action === 'created',
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
