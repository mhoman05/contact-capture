# Pocket CRM

**The app lives here: https://contact-capture.matthias-homan.workers.dev/** (open it in Chrome on the phone; Chrome menu → *Install app*; the first time open it as `https://contact-capture.matthias-homan.workers.dev/#t=<your access token>` so the phone learns the token). The address `https://mhoman05.github.io/contact-capture/` is only the old GitHub Pages page that shows this README; it is not the app.

(The repository and the Worker are still called `contact-capture`; only the name you see changed.)

Share a business card photo, a screenshot of an email signature or a LinkedIn profile, or just selected text, from your Android phone. Claude reads the details and files the person in your Notion Work CRM.

```
Android share sheet → this app → Cloudflare Worker → Claude (reads the image) → Notion People / Companies / Interactions
```

One Cloudflare Worker does everything: it serves the app (the `public/` folder) and it runs the API (`worker/`). The app and the API share one address, like `https://contact-capture.matthias-homan.workers.dev`, so there is no GitHub Pages, no cross-site setup, and no clash with other apps on your phone. Cloudflare's free plan is enough.

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

1. Push to `main`. The workflow **Deploy worker** runs the tests and deploys. Open the finished run → **deploy** → the step *Run cloudflare/wrangler-action*; its log ends with the address, like `https://contact-capture.matthias-homan.workers.dev`. (If it asks for a `workers.dev` subdomain, open *Workers & Pages* in the Cloudflare dashboard once to create it, then re-run.)
2. Check it answers: open `<that address>/health` in a browser. You should see `{"ok":true}`.
3. On the Android phone, open `<that address>/#t=<CAPTURE_TOKEN>` in Chrome. The token is saved on the phone and removed from the address bar.
4. Chrome menu → **Install app**, then open the installed app once so it can receive shares.

Changes to the files in `public/` alone do not trigger a deploy; after copying new files, open **Actions → Deploy worker → Run workflow** (branch `main`) to publish them.

## Using it

- **At an event:** at the top of the Add screen, tap **Choose** next to *Event*. Pick one of your events from Notion (the ones closest to today are first, and you can search) or tap **＋ New event** (name, date, type, optional location; it is created in your Events database and selected). The event is remembered for 12 hours, so you set it once. **No event** clears it.
  - Take a photo of each card → *Share* → **Pocket CRM** → type a **note about this person** (optional: what you talked about, what to follow up) → *Add to CRM*. Tick *I met them in person* to also log a meeting today (an *Event* interaction named after the event).
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

## People: your whole CRM on the phone

The **People** tab shows everyone in your Notion People database: a list you can search (name, company, role, email, phone, notes, event; accents are ignored), sort (**A–Z** with letter headings, or **Newest first**), and filter (**To review**, **Follow up**, **Duplicates**, and by **tier**). It shows 100 at a time with *Show more*.

- **Tap a name** to reveal the details: phone, email, LinkedIn, Telegram, location, how you met, events, follow-up date, your notes, and the **meetings and interactions** logged for them (calendar meetings and calls, emails, events …), newest first. Quick buttons call, WhatsApp, email, or open Telegram and LinkedIn.
- **✎ Edit** opens the editor: name, company, role, phone, email, LinkedIn, Telegram, location, **tier** (how often to stay in touch), a new note (added to *Notes* with today's date, earlier notes are kept), the follow-up date and *Needs review*. Everything saves straight to Notion, only the fields you changed are sent, and clearing a field empties it in Notion.
- **Also on the details screen:** *Save to phone contacts*, *Delete person* (Notion's trash, restorable for 30 days) and *Open in Notion*.
- **The phone keeps its own copy** of the list (IndexedDB). The first open reads everyone once (100 at a time, with a progress count); after that the app only asks for people edited since the last time, so opening the tab is quick. Once a day, and whenever you tap *Reload everything from Notion*, it reads everything again, which is also how people deleted directly in Notion disappear from the phone. Offline, the last copy is shown.
- **Follow-up reminder:** every new person gets a *Next Follow-up* date 7 days ahead (change the number of days in ⚙ Settings; 0 turns it off). People already in the CRM never get their date changed. People whose date has come are marked *Follow up today* or *overdue*, the **Follow up** filter lists them oldest first, and the People tab shows their count (also as a badge on the app icon where Android allows it, updated whenever the app is opened).
- **Done with a follow-up:** in the editor, *Followed up* clears the date and adds a "Followed up" note; *+7 days* / *+30 days* snooze it; untick *Needs review* once you have checked the person.
- In Notion the same people are in **People → "Follow up due (reminder)"** (everyone whose Next Follow-up is today or earlier).

## Tasks: your Notion Task Database on the phone

The **Tasks** tab is your Notion *Task Database*. Two lists plus follow-ups:

- **CRM tasks**: tasks linked to a person or a company (the same rule as your Notion view "CRM: open follow-ups").
- **My to-dos**: tasks linked to nobody.
- **Follow up**: the people whose follow-up date has come (from the People tab); tap one to open them.
- **Filters** for the two task lists: *Today & overdue*, *This week*, *All open* (Not started and In progress), *Waiting on*, *Backlog* (parked, not counted as open) and *Done* (completed in the last 45 days). A search box looks at title, notes, next step, tags, companies and linked people. The tab shows how many tasks are due or overdue.
- **Add a task in one line:** type it and press Enter. Optional: *Today / Tomorrow / Next week* or a date, *Work / Personal / Advisory*, *Waiting on someone else*, and **link to a person** (search the People list). Linking a person makes it a CRM task; without one it goes to My to-dos. New tasks start as *Not started*.
- **Complete with one tap** (the circle). The completion date is set, and a message offers **Undo** for a few seconds. Tap a done task's circle to reopen it.
- **Tap a task** to edit it: title, status (Not started, In progress, Backlog, Done), due date (+1 day, +1 week, no date), waiting on, linked people (tap a name to open the person), type, tags, notes, next step. *Delete* sends it to Notion's trash (restorable for 30 days).
- **On a person's screen** (People tab) you see their open tasks and **＋ Add task for this person**.
- **Without signal** everything still works: new tasks, completing and edits show at once and are sent in order when you are online again (a status line says how many are waiting). A task that Notion rejects is removed again with a message.
- Sending the same new task twice (a lost reply, a retry) never creates it twice.
- Changes you make in Notion show up the next time you open the tab: the phone keeps its own copy and asks only for what changed (everything again once a day, or with *Reload everything*).

### Connecting Notion to the Task Database (one-time)

Your Task Database lives under a different Notion page ("DATABASES") than the CRM, so the app's Notion connection may not see it yet. In the app open **⚙ → Check Notion connections**: it names the Notion connection the app uses, lists every database the app needs with ✓ or ✗, and lists every database that connection can see. For each ✗: in Notion open that database (or its parent page), tap **•••** at the top right, choose **Connections** and add the app's connection (the same one you created for the CRM), then check again. The Meetings database (shown in a person's history) may need the same.

## Companies (inside the People tab)

At the top of the **People** tab, the switch **People | Companies** shows your Notion Companies database.

- **List:** search (name, industry, location, notes), filter by **relationship** (Target, Prospect, Active, Partner, Dormant), sort A–Z or newest first, 100 at a time. Each row shows industry, location, relationship, priority and how many people work there. Like People, the phone keeps its own copy and only fetches what changed.
- **Tap a company** for its details (website, LinkedIn, why it matters, notes), **People here** (tap one to open them), **Open tasks** (tasks linked to the company or to any of its people; tap to edit), and **meetings and interactions** of the company and its people, newest first.
- **✎ Edit** changes name, website, LinkedIn, HQ / location, industry, relationship, target priority, why they matter and notes; empty values clear the field in Notion. **＋ New company** creates one; a company with the same name (ignoring Inc., Ltd, GmbH …) is never created twice, the existing one is opened instead.
- **＋ Add task** opens the Tasks tab with the company already linked; **＋ Add person** opens the typed form with the company filled in. On a person's screen, the company name is a link to the company.

## No signal, undo, phone contacts and duplicates

- **Capture without signal.** If sending fails because there is no connection (or the service has a hiccup), the capture, photos included, is saved on the phone and a card *N captures waiting to send* appears at the top. It is sent by itself, in order, as soon as the app is open and online again (when the connection returns, when you open the app, and every 45 seconds while it is open); *Send now* does it on demand and *Show* lists what is waiting, each with *Remove*. Captures the service rejects (for example an unreadable email address) are not queued: you fix them and retry. Sending the same capture twice never creates a second person or a second meeting. Create a new event while you still have signal; the event list itself is remembered offline.
- **Undo.** Right after adding someone, their result has **↩ Undo (remove)**: it moves the person, the meeting logged for them and the company page this capture created (only if nobody else uses it) to Notion's trash, where Notion keeps it for 30 days. Undo is offered for people who were *added*; for existing people who only got empty fields filled, edit them in *People*.
- **Delete.** In *People*, open a person and tap **🗑 Delete person** (same trash, same 30 days).
- **Save to phone contacts.** The result of a capture and the person screen in *People* have **📱 Save to phone contacts**. It opens the phone's share sheet with a contact file; choose *Contacts* and the usual "save contact" screen appears (if sharing files is not possible, the file is downloaded: open it to add the contact).
- **Duplicates.** *People → Duplicates* suggests pairs that look like the same person: same email, phone number, LinkedIn or Telegram (strong), or the same or a similar name (people with different emails are never suggested by name). Each pair shows both people and suggests which to keep (the one with more details). **Keep this one** merges: the other person's details fill empty fields, their events, meetings, tasks and other links move over, their notes are appended, and they go to Notion's trash. **Different people** hides the pair on this phone. Nothing is ever merged without you tapping.
  - Looking for duplicates reads your whole People table, so it can be slow with thousands of people, and on Cloudflare's free plan a very large table may hit the time limit. A few hundred people is fine.

## My QR card (sharing your own details)

The **My QR card** tab turns your details into a QR code that the other person scans with their normal phone camera. Their phone offers **Add contact**, with no app, account or internet needed on their side.

- **Your details live in Notion**, in the database **My sharing details** (under the Work CRM page). Each row is one detail: its **Value**, a **Type** (First name, Last name, Company, Role, Phone, Email, Website, Address) and the **Groups** it belongs to (Personal, Professional, Indoor golf club; one row can be in several). Rows with an empty Value are ignored. Add your own rows or groups in Notion whenever you like.
- **In the app you choose what to share right now.** Tick a group to include its details, then tick or untick single details for this person. The code updates immediately. **Edit values** changes a value and saves it back to Notion; **Reload from Notion** pulls changes made there (the tab also reloads each time you open it).
- Professional and club can both be ticked: the first company becomes the company and role on the card; the other is added in the note, and its phone, email and website carry its name as a label (or the row's **Label**, if you set one), so they do not look like a second work number.
- **Show full screen** gives a big white code and keeps the screen on. **Share link** opens the phone's share sheet (WhatsApp, Telegram, SMS, email …) with a link; whoever opens it sees a small page with your name and the details you ticked and a big **Add to contacts** button, which downloads the contact file; their phone then offers to save it to their contacts (if nothing opens, they tap the file in their Downloads). No scanning and no app needed. The contact card is inside the link (the address `/v?c=…` is public on purpose, shows only what is in the link, escapes everything, and can only ever return a plain contact card; nothing is stored, but the link contains the ticked details, so share it only with people you want to have them). **Save contact file** just downloads the `.vcf` (Android Chrome cannot hand `.vcf` files to the share sheet).
- The phone keeps the last copy it loaded, so the code still works with no signal.
- Long-press the installed app icon and choose **My QR card** for a one-tap shortcut (Android may need a day to pick it up).
- The code is a standard vCard 3.0. The more you tick, the denser the code; the app warns when it gets hard to scan.

The Worker reads and edits that one database only (`NOTION_ME_DB` in `worker/wrangler.toml`); it refuses to edit any other Notion page.

## New phone, or lost phone

Nothing is stored only on the phone except the access token and your "send straight away" choice.

1. Install the app: open the Worker address (`https://contact-capture.matthias-homan.workers.dev`) in Chrome, then menu → **Install app**.
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
npm test            # 101 tests: matching rules, Notion writes (against an in-memory Notion), access control, serving the app
```

Run everything locally with `npx wrangler@4 dev`, putting the three secrets in `worker/.dev.vars` (git-ignored), then open `http://127.0.0.1:8787/`.

The code is tested against a simulated Notion, a stubbed model and the real Cloudflare runtime running locally. The first real run needs checking by hand: share one card and look at the result in Notion.
