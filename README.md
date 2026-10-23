# Contact capture

Share a business card photo, a screenshot of an email signature or a LinkedIn profile, or just selected text, from your Android phone. Claude reads the details and files the person in your Notion Work CRM.

```
Android share sheet → this app → Cloudflare Worker → Claude (reads the image) → Notion People / Companies / Interactions
```

One Cloudflare Worker does everything: it serves the app (the `public/` folder) and it runs the API (`worker/`). The app and the API share one address, like `https://contact-capture.<your-name>.workers.dev`, so there is no GitHub Pages, no cross-site setup, and no clash with other apps on your phone. Cloudflare's free plan is enough.

## What it does with each contact

- **Finds the person first**: by email, then LinkedIn address, then name (ignoring accents and word order). Someone already in the CRM is updated, never duplicated.
- **Only fills empty fields.** It never overwrites something you already have. If the card disagrees with the CRM (a different email, role or company), it leaves the CRM alone and shows you a warning.
- **A new person** gets name, email, phone, LinkedIn, role, company (reusing the existing company page, or creating one), plus "How We Know Each Other" from what you typed. Notes record the date it was added.
- **A likely duplicate** (for example "Álvaro Durán" when "Álvaro Durán Casares" exists) is added as new but flagged with a link, so you can merge by hand.
- **Optionally logs an "In person" interaction** dated today, so the follow-up cadence counts the meeting. Untick the box to skip it.
- People with a LinkedIn address but no "Last Enriched" date show up in your existing *Needs LinkedIn enrichment* view.

## One-time setup

Five secrets go in the repository's **Settings → Secrets and variables → Actions** (the *Actions* tab, not Dependabot or Codespaces).

| Secret | Where to get it |
|---|---|
| `NOTION_TOKEN` | Notion → Developer tools → Connections → *New connection* → copy the API token. Then open the **Work CRM** page → `•••` → *Connections* and add that connection, so it can see People, Companies and Interactions. |
| `ANTHROPIC_API_KEY` | console.anthropic.com → *API keys*. This is separate from a claude.ai subscription. |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → *My Profile → API Tokens → Create Token* → template **Edit Cloudflare Workers**. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → *Workers & Pages*, shown on the right. |
| `CAPTURE_TOKEN` | A password you invent (letters and numbers only), for example the output of `openssl rand -hex 16`. Only someone with it can use the service. |

Then:

1. Push to `main`. The workflow **Deploy worker** runs the tests and deploys. Open the finished run → **deploy** → the step *Run cloudflare/wrangler-action*; its log ends with the address, like `https://contact-capture.<your-name>.workers.dev`. (If it asks for a `workers.dev` subdomain, open *Workers & Pages* in the Cloudflare dashboard once to create it, then re-run.)
2. Check it answers: open `<that address>/health` in a browser. You should see `{"ok":true}`.
3. On the Android phone, open `<that address>/#t=<CAPTURE_TOKEN>` in Chrome. The token is saved on the phone and removed from the address bar.
4. Chrome menu → **Install app**, then open the installed app once so it can receive shares.

Changes to the files in `public/` alone do not trigger a deploy; run **Actions → Deploy worker → Run workflow** after editing them.

## Using it

- **Business card:** take a photo (or open it in your gallery) → *Share* → **Contact capture** → type where you met → *Add to CRM*. You can attach the front and back, or several cards in one photo.
- **Email signature or LinkedIn profile:** screenshot it and share the screenshot the same way, or select the text, *Share*, **Contact capture**.
- **Opening the app directly** works too: *Take photo*, *Choose photos* or *Paste text instead*.

The app shrinks photos to 1600 px before sending, so uploads are small even on mobile data.

## Privacy and cost

- Photos and text are sent to the Anthropic API to be read. The Worker keeps nothing; Notion keeps only the fields it extracted. Card photos themselves are not stored anywhere.
- The access token is stored in the phone's browser storage only. To rotate it, change the `CAPTURE_TOKEN` secret, re-run the workflow, and open a new setup link on the phone.
- Reading one card costs roughly one US cent with the default model (`claude-opus-5-5`). Set `MODEL = "claude-sonnet-5-5"` in `worker/wrangler.toml` to make it cheaper.
- Card text is treated as data: the instructions to Claude say to ignore any commands printed on a card, its reply is validated field by field, and the Worker can only write the fields listed above.

## Development

```bash
cd worker
npm ci
npm run typecheck
npm test            # 34 tests: matching rules, Notion writes (against an in-memory Notion), access control, serving the app
```

Run everything locally with `npx wrangler@4 dev`, putting the three secrets in `worker/.dev.vars` (git-ignored), then open `http://127.0.0.1:8787/`.

The code is tested against a simulated Notion, a stubbed model and the real Cloudflare runtime running locally. The first real run needs checking by hand: share one card and look at the result in Notion.
