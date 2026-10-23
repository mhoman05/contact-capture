# Contact capture

Share a business card photo, a screenshot of an email signature or a LinkedIn profile, or just selected text, from your Android phone. Claude reads the details and files the person in your Notion Work CRM.

```
Android share sheet → this app (GitHub Pages) → Cloudflare Worker → Claude (reads the image) → Notion People / Companies / Interactions
```

The app is a static page hosted on GitHub Pages. It cannot hold secrets, so a small Cloudflare Worker (`worker/`) sits between the page and Claude/Notion and keeps the keys. Cloudflare's free plan is enough.

## What it does with each contact

- **Finds the person first**: by email, then LinkedIn address, then name (ignoring accents and word order). Someone already in the CRM is updated, never duplicated.
- **Only fills empty fields.** It never overwrites something you already have. If the card disagrees with the CRM (a different email, role or company), it leaves the CRM alone and shows you a warning.
- **A new person** gets name, email, phone, LinkedIn, role, company (reusing the existing company page, or creating one), plus "How We Know Each Other" from what you typed. Notes record the date it was added.
- **A likely duplicate** (for example "Álvaro Durán" when "Álvaro Durán Casares" exists) is added as new but flagged with a link, so you can merge by hand.
- **Optionally logs an "In person" interaction** dated today, so the follow-up cadence counts the meeting. Untick the box to skip it.
- People with a LinkedIn address but no "Last Enriched" date show up in your existing *Needs LinkedIn enrichment* view.

## One-time setup

You need five secrets. They go in the repository's **Settings → Secrets and variables → Actions**.

| Secret | Where to get it |
|---|---|
| `NOTION_TOKEN` | notion.so/profile/integrations → *New integration* (internal) → copy the secret. Then open the **Work CRM** page → `⋯` → *Connections* → add that integration, so it can see People, Companies and Interactions. |
| `ANTHROPIC_API_KEY` | console.anthropic.com → *API keys*. This is separate from a claude.ai subscription. |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → *My Profile → API Tokens → Create Token* → template **Edit Cloudflare Workers**. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → *Workers & Pages*, shown on the right. |
| `CAPTURE_TOKEN` | A password you invent, for example the output of `openssl rand -base64 24`. The app sends it so only you can use the service. |

Then:

1. Push to `main` (GitHub Desktop: *Commit to main*, then *Push origin*). The workflow `Deploy worker` runs the tests and deploys the Worker. Its log ends with the address, like `https://contact-capture.<your-name>.workers.dev`.
   If the log complains about a `workers.dev` subdomain, open *Workers & Pages* in the Cloudflare dashboard once to create it, then re-run the workflow.
2. Check it answers: open `<that address>/health` in a browser. You should see `{"ok":true}`.
3. Turn on GitHub Pages: repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`**. After a minute the app is at `https://<owner>.github.io/contact-capture/`.
4. On the phone, open this link once in Chrome (it fills in the settings, then removes itself from the address bar):
   `https://<owner>.github.io/contact-capture/#w=<worker address>&t=<CAPTURE_TOKEN>`
5. Chrome menu → **Install app** (or *Add to Home screen*). Open the app once after installing so it can receive shares.

The Worker's other settings are in `worker/wrangler.toml`: the Pages origins that may call it (`ALLOWED_ORIGIN`, set to both of your accounts; trim it to the one you use) and the Notion database ids.

## Using it

- **Business card:** take a photo (or open it in your gallery) → *Share* → **Contact capture** → type where you met → *Add to CRM*. You can attach the front and back, or several cards in one photo.
- **Email signature or LinkedIn profile:** screenshot it and share the screenshot the same way, or select the text, *Share*, **Contact capture**.
- **Opening the app directly** works too: *Take photo*, *Choose photos* or *Paste text instead*.

The app shrinks photos to 1600 px before sending, so uploads are small even on mobile data.

## Privacy and cost

- Photos and text are sent to the Anthropic API to be read. The Worker keeps nothing; Notion keeps only the fields it extracted. Card photos themselves are not stored anywhere.
- The access token and Worker address are stored in the phone's browser storage only. To rotate the token, change the `CAPTURE_TOKEN` secret, re-run the workflow, and open a new setup link on the phone.
- Reading one card costs roughly one US cent with the default model (`claude-opus-5-5`). Set `MODEL = "claude-sonnet-5-5"` in `wrangler.toml` to make it cheaper.
- Card text is treated as data: the instructions to Claude say to ignore any commands printed on a card, its reply is validated field by field, and the Worker can only write the fields listed above.

## Development

```bash
cd worker
npm ci
npm run typecheck
npm test            # 29 tests: matching rules, Notion writes (against an in-memory Notion), access control
```

Run the Worker locally with `npx wrangler dev`, putting the three secrets in `worker/.dev.vars` (git-ignored).

The code is tested against a simulated Notion and a stubbed model. The first real run needs checking by hand: share one card and look at the result in Notion.
