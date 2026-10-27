export interface Env {
  // Secrets (set with `wrangler secret put`, or by the deploy workflow)
  ANTHROPIC_API_KEY: string;
  NOTION_TOKEN: string;
  CAPTURE_TOKEN: string;
  // Vars (wrangler.toml)
  ALLOWED_ORIGIN: string;
  NOTION_PEOPLE_DB: string;
  NOTION_COMPANIES_DB: string;
  NOTION_INTERACTIONS_DB: string;
  NOTION_ME_DB?: string; // "My sharing details" database
  NOTION_EVENTS_DB?: string; // Events database
  MODEL?: string;
  // Static files of the app (the public/ folder), served by Cloudflare. Absent in unit tests.
  ASSETS?: Fetcher;
}

export interface ExtractedContact {
  full_name: string;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  company: string | null;
  linkedin_url: string | null;
  website: string | null;
  location: string | null;
  notes: string | null;
  telegram_url?: string | null; // only set by typed or scanned contacts
  source_image?: number | null; // 1-based number of the image the person was read from
}

export interface CaptureImage {
  media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: string; // base64, no data: prefix
  note?: string; // your note about the person on this card (never sent to the model)
}

/** A contact typed in (or filled from a scanned QR code) instead of read from a photo. Already validated by parseRequest. */
export interface ManualContact {
  contact: ExtractedContact;
  source: 'typed in' | 'a scanned QR code';
}

export interface CaptureRequest {
  images: CaptureImage[];
  text: string; // pasted/shared text, e.g. an email signature
  note: string; // where/how the user met the person
  today: string; // YYYY-MM-DD in the user's time zone
  log_meeting: boolean; // also add an "In person" interaction dated today (photos and typed contacts only)
  manual?: ManualContact;
  event_id?: string; // the Notion Events page the people were met at
  follow_up_days?: number; // new people get a Next Follow-up date this many days ahead (0 or absent: none)
}

export interface CaptureResult {
  name: string;
  company: string | null;
  action: 'created' | 'updated' | 'unchanged';
  event: string | null; // the event they were linked to
  needs_review: boolean; // new people are flagged in Notion so they show up in the review view
  page_url: string;
  person_id: string;
  company_created_id: string | null; // set when this capture created the company page (so Undo can remove it)
  details: { name: string; company: string; role: string; email: string; phone: string; linkedin: string; telegram: string }; // as saved, for "Save to phone contacts"
  added: string[]; // CRM fields that were filled in
  interaction_url: string | null;
  warnings: string[];
}
