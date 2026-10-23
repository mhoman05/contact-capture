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
}

export interface CaptureImage {
  media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  data: string; // base64, no data: prefix
}

export interface CaptureRequest {
  images: CaptureImage[];
  text: string; // pasted/shared text, e.g. an email signature
  note: string; // where/how the user met the person
  today: string; // YYYY-MM-DD in the user's time zone
  log_meeting: boolean; // also add an "In person" interaction dated today
}

export interface CaptureResult {
  name: string;
  company: string | null;
  action: 'created' | 'updated' | 'unchanged';
  page_url: string;
  added: string[]; // CRM fields that were filled in
  interaction_url: string | null;
  warnings: string[];
}
