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
- **Logs an "In person" meeting only when you tick the box** "I met them in person", and only for photos. Tick it when you meet someone today; leave it off when adding cards in bulk at home or when capturing an email signature (so nothing false is recorded). The box remembers how you left it.
- **Marks every new person "Needs review"** in Notion. Open People → **To review (captured)**, check the details, fill in the rest, and untick the box.
- **Never guesses**: a blurred or cut-off phone number or email comes back empty rather than partly right.
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

Changes to the files in `public/` alone do not trigger a deploy; after copying new files, open **Actions → Deploy worker → Run workflow** (branch `main`) to publish them.

## Using it

- **At an event:** at the top of the Add screen, tap **Choose** next to *Event*. Pick one of your events from Notion (the ones closest to today are first, and you can search) or tap **＋ New event** (name, date, type, optional location; it is created in your Events database and selected). The event is remembered for 12 hours, so you set it once. **No event** clears it.
  - Take a photo of each card → *Share* → **Contact capture** → type a **note about this person** (optional: what you talked about, what to follow up) → *Add to CRM*. Tick *I met them in person* to also log a meeting today (an *Event* interaction named after the event).
  - Everyone you add is linked to the event (People → *Events*), and *How We Know Each Other* says "Met at <event>". People already in the CRM keep what they have; the event is added to their list of events. The note goes into their *Notes* and into the meeting summary. Fill in details in Notion later; new people are under *To review*. In Settings you can switch on "send straight away" so sharing a photo is the only step.
- **Bulk after an event:** choose the event (or leave it empty), leave *I met them in person* unticked, share up to 12 cards at a time, and write a short note under each photo. Claude tells which person came from which photo; if it cannot tell, the notes are shown as a warning instead of being guessed. Review the people the same day in *To review (captured)*.
- **No business card:** tap **Type it in** and enter name, company, phone, email (and under *More*: role, LinkedIn, Telegram, website). The event, the note and the *I met them in person* tickbox work the same as for photos. Nothing is sent to Claude, so it costs nothing; the person lands in Notion marked *Needs review*.
- **Scan a QR code:** tap **Scan a QR code** and point the camera at it, or choose a photo or screenshot of the code. The details fill the same form so you can correct them before sending.
  - *LinkedIn* QR code: the profile link is saved in the LinkedIn field. LinkedIn does not put the name in the code, so the app guesses it from the address when it can (check it) and otherwise asks you to type it. The person then shows up in *Needs LinkedIn enrichment*.
  - *Telegram* QR code (a `t.me/username` link): saved in the new **Telegram** field of People. Telegram only shares the username, so type the name. Group invite links are refused.
  - *Contact card* QR codes (a vCard, for example from another person's QR card app, or this app's own *My QR card*): name, company, role, phone, email and links all fill in.
  - WhatsApp (`wa.me`) links fill the phone number; other websites fill the website.
- **Email signature or LinkedIn profile:** share a screenshot (not a photo of a screen) or select the text and share it. If the person is already in the CRM, only their empty fields are filled; no meeting is logged.
- **Opening the app directly** works too: *Take photo*, *Choose photos* or *Paste text instead*.

The app shrinks photos to 1600 px before sending, so uploads are small even on mobile data.

## Recent: follow up on the people you added

The **Recent** tab lists the last 100 people added to the CRM, newest first, with filters **All**, **To review** and **Follow up**, and a search box (name, company, role, notes, event).

- **Tap a name** to see everything about them and edit it: name, company, role, phone, email, LinkedIn, Telegram, location. Type a **note** and it is added to their Notes with today's date (earlier notes are kept). Everything saves straight to Notion; only the fields you changed are sent, and clearing a field empties it in Notion.
- **Quick actions** appear for what you have: call, WhatsApp, email, Telegram, LinkedIn, and *Open in Notion*.
- **Follow-up reminder:** every new person gets a *Next Follow-up* date 7 days ahead (change the number of days in ⚙ Settings; 0 turns it off). People already in the CRM never get their date changed. In the list, people whose date has come are marked *Follow up today* or *overdue*, the **Follow up** filter shows them oldest first, and the Recent tab shows their count (also as a badge on the app icon where Android allows it, updated whenever the app is opened).
- **Done with a follow-up:** *Followed up* clears the date and adds a "Followed up" note; *+7 days* / *+30 days* snooze it; untick *Needs review* once you have checked the person.
- In Notion the same people are in **People → "Follow up due (reminder)"** (everyone whose Next Follow-up is today or earlier).

## My QR card (sharing your own details)

The **My QR card** tab turns your details into a QR code that the other person scans with their normal phone camera. Their phone offers **Add contact**, with no app, account or internet needed on their side.

- **Your details live in Notion**, in the database **My sharing details** (under the Work CRM page). Each row is one detail: its **Value**, a **Type** (First name, Last name, Company, Role, Phone, Email, Website, Address) and the **Groups** it belongs to (Personal, Professional, Indoor golf club; one row can be in several). Rows with an empty Value are ignored. Add your own rows or groups in Notion whenever you like.
- **In the app you choose what to share right now.** Tick a group to include its details, then tick or untick single details for this person. The code updates immediately. **Edit values** changes a value and saves it back to Notion; **Reload from Notion** pulls changes made there (the tab also reloads each time you open it).
- Professional and club can both be ticked: the first company becomes the company and role on the card; the other is added in the note, and its phone, email and website carry its name as a label (or the row's **Label**, if you set one), so they do not look like a second work number.
- **Show full screen** gives a big white code and keeps the screen on. **Send as contact file** shares a `.vcf` through WhatsApp, email or anything else, for people who cannot scan.
- The phone keeps the last copy it loaded, so the code still works with no signal.
- Long-press the installed app icon and choose **My QR card** for a one-tap shortcut (Android may need a day to pick it up).
- The code is a standard vCard 3.0. The more you tick, the denser the code; the app warns when it gets hard to scan.

The Worker reads and edits that one database only (`NOTION_ME_DB` in `worker/wrangler.toml`); it refuses to edit any other Notion page.

## New phone, or lost phone

Nothing is stored only on the phone except the access token and your "send straight away" choice.

1. Install the app: open the Worker address (`https://contact-capture.<your-name>.workers.dev`) in Chrome, then menu → **Install app**.
2. Open `<that address>/#t=<your CAPTURE_TOKEN>` once. The token is saved on the phone and removed from the address bar. (Keep the token in a password manager. It is also in GitHub: repository → Settings → Secrets, though secrets can be replaced but not read; to get a new one, change `CAPTURE_TOKEN` there and re-run the deploy.)
3. Open **My QR card**. Your details come back from Notion.

The app itself is in GitHub and Cloudflare, and your contacts and details are in Notion, so there is nothing else to restore.

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
npm test            # 68 tests: matching rules, Notion writes (against an in-memory Notion), access control, serving the app
```

Run everything locally with `npx wrangler@4 dev`, putting the three secrets in `worker/.dev.vars` (git-ignored), then open `http://127.0.0.1:8787/`.

The code is tested against a simulated Notion, a stubbed model and the real Cloudflare runtime running locally. The first real run needs checking by hand: share one card and look at the result in Notion.
