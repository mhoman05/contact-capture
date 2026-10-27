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

## Optional: Save to phone contacts (Google Contacts setup)

One-time, about 15 minutes. It gives the service permission to add contacts to your Google account only (it cannot read other things). Keep every value below in your password manager and never paste them into a chat.

**Part A, Google**

1. Open console.cloud.google.com, sign in with the Google account your phone's Contacts use, accept the terms. Top left, open the project picker → *New project* → name it `Pocket CRM` → *Create*, and make sure it is selected.
2. Menu (☰) → *APIs & Services* → *Library* → search **People API** → open it → *Enable*.
3. Menu → *APIs & Services* → *OAuth consent screen* (it may be called *Google Auth Platform*) → *Get started*. App name `Pocket CRM`, support email yours → Next. Audience **External** → Next. Contact email yours → Next → tick the agreement → Continue → *Create*.
4. In the left menu open *Branding* and fill in *Application home page* (`https://contact-capture.matthias-homan.workers.dev/`), *Application privacy policy link* (`https://contact-capture.matthias-homan.workers.dev/privacy.html`, a page the app serves) and, if it asks, the authorized domain, then *Save*. Then open *Audience* → **Publish app** → Confirm. (If you skip this the permission stops working after 7 days. If the button is greyed out, hover over it: the tooltip names what is still missing.)
5. Left menu → *Clients* → *Create client*. Type **Web application**, name `Pocket CRM`. Under *Authorized redirect URIs* click *Add URI* and enter `https://developers.google.com/oauthplayground`. *Create*. A box shows the **Client ID** and **Client secret**; copy both.
6. Open developers.google.com/oauthplayground. Click the gear (top right), tick **Use your own OAuth credentials**, paste the Client ID and Client secret, close the box.
7. In the left list, scroll to the box **Input your own scopes**, type `https://www.googleapis.com/auth/contacts` and click *Authorize APIs*. Choose your account. On "Google hasn't verified this app" click *Advanced* → *Go to Pocket CRM (unsafe)* (it is your own app) → Continue → Allow.
8. Back in the Playground, Step 2: click **Exchange authorization code for tokens** and copy the **Refresh token** (it starts with `1//`).

**Part B, Cloudflare**

9. dash.cloudflare.com → *Workers & Pages* → `contact-capture` → *Settings* → *Variables and Secrets* → *Add*. Type **Secret**. Add three, one at a time: `GOOGLE_CLIENT_ID` (the Client ID), `GOOGLE_CLIENT_SECRET` (the Client secret), `GOOGLE_REFRESH_TOKEN` (the refresh token). Click *Deploy* after the last one.
10. In the app: People → open a person → **📱 Save to phone contacts**. After a moment the person is in your phone's Contacts. (Android's *Settings → Google → Contacts sync* must be on, which it normally is.)

If the permission ever stops working (the app says Google refused it), repeat steps 6 to 9 and replace only `GOOGLE_REFRESH_TOKEN`.

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
- **＋ Log meeting or interaction** (on the details screen, at the bottom of the *Meetings and interactions* box, just as *Add task for this person* sits in the *Open tasks* box): choose what it was (*In person, Call, Online call, WhatsApp / Message, Email, LinkedIn, Event*, or *Meeting* for the Meetings database), the date (today, yesterday or pick), a direction for calls and messages, an optional title (otherwise "Call with Ann Adams"), what was discussed, and *Needs follow-up*. You can also set the person's **next follow-up** (in 3 days, 1 week, 2 weeks, 1 month, or none) in the same step. It is written to Notion's Interactions (or Meetings) database, appears in the person's history straight away and counts as contact for the follow-up cadence. Logging the same thing twice never creates it twice.
- **Also on the details screen:** *Save to phone contacts*, *Delete person* (Notion's trash, restorable for 30 days) and *Open in Notion*.
- **The phone keeps its own copy** of the list (IndexedDB). The first open reads everyone once (100 at a time, with a progress count); after that the app only asks for people edited since the last time, so opening the tab is quick. Once a day, and whenever you tap *Reload everything from Notion*, it reads everything again, which is also how people deleted directly in Notion disappear from the phone. Offline, the last copy is shown.
- **Follow-up reminder:** every new person gets a *Next Follow-up* date 7 days ahead (change the number of days in ⚙ Settings; 0 turns it off). People already in the CRM never get their date changed. People whose date has come are marked *Follow up today* or *overdue*, the **Follow up** filter lists them oldest first, and the People tab shows their count (also as a badge on the app icon where Android allows it, updated whenever the app is opened).
- **Done with a follow-up:** in the editor, *Followed up* clears the date and adds a "Followed up" note; *+7 days* / *+30 days* snooze it; untick *Needs review* once you have checked the person.
- In Notion the same people are in **People → "Follow up due (reminder)"** (everyone whose Next Follow-up is today or earlier).

## Tasks: your Notion Task Database on the phone

The **Tasks** tab is your Notion *Task Database*. Two lists plus follow-ups:

- **CRM tasks**: tasks linked to a person or a company (the same rule as your Notion view "CRM: open follow-ups").
- **My to-dos**: tasks linked to nobody.
- **Follow up**: the open tasks you ticked *Waiting on someone else* on, from both lists, soonest due first. They are kept out of *CRM tasks* and *My to-dos* (and their counts) because you cannot do them yourself; ticking one done, as soon as the answer arrives, removes it from here. People whose follow-up date has come are in the **People** tab (filter *Follow up*).
- **Filters** for the two task lists: *Today & overdue*, *This week*, *All open* (Not started and In progress), *Backlog* (parked, not counted as open) and *Done* (completed in the last 45 days). A search box looks at title, notes, next step, tags, companies and linked people. The tab shows how many tasks are due or overdue.
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
- **Save to phone contacts.** The result of a capture and the person screen in *People* have **📱 Save to phone contacts**. It adds the person (name, company, role, phone, email, LinkedIn, Telegram, address, a note with how you met) to your **Google Contacts**, and Android syncs it to the phone's Contacts within a minute, so there is no file to open. A person who is already there (same email, same phone or same name) is not added twice. This needs the one-time Google setup below. Until then, or if Google is unreachable, the button falls back to a contact file: the share sheet (choose *Contacts*) or a download.
- **Duplicates.** *People → Duplicates* suggests pairs that look like the same person: same email, phone number, LinkedIn or Telegram (strong), or the same or a similar name (people with different emails are never suggested by name). Each pair shows both people and suggests which to keep (the one with more details). **Keep this one** merges: the other person's details fill empty fields, their events, meetings, tasks and other links move over, their notes are appended, and they go to Notion's trash. **Different people** hides the pair on this phone. Nothing is ever merged without you tapping.
  - Looking for duplicates reads your whole People table, so it can be slow with thousands of people, and on Cloudflare's free plan a very large table may hit the time limit. A few hundred people is fine.

## My QR card (sharing your own details)

The **My QR card** tab turns your details into a QR code that the other person scans with their normal phone camera. Their phone offers **Add contact**, with no app, account or internet needed on their side.

- **Your details live in Notion**, in the database **My sharing details** (under the Work CRM page). Each row is one detail: its **Value**, a **Type** (First name, Last name, Company, Role, Phone, Email, Website, Address) and the **Groups** it belongs to (Personal, Professional, Indoor golf club; one row can be in several). Rows with an empty Value are ignored. Add your own rows or groups in Notion whenever you like.
- **In the app you choose what to share right now.** Tick a group to include its details, then tick or untick single details for this person. The code updates immediately. **Edit values** changes a value and saves it back to Notion; **Reload from Notion** pulls changes made there (the tab also reloads each time you open it).
- Professional and club can both be ticked: the first company becomes the company and role on the card; the other is added in the note, and its phone, email and website carry its name as a label (or the row's **Label**, if you set one), so they do not look like a second work number.
- **Show full screen** gives a big white code and keeps the screen on. **Share link** opens the phone's share sheet (WhatsApp, Telegram, SMS, email …) with your details in plain words plus a link; whoever opens it sees a small page with your name and the details you ticked and a **Download contact file** button (the details above it are tap-to-call and tap-to-email). On Android they tap the downloaded file and choose *Contacts*; on iPhone it opens straight away. The text that goes with the link also lists the details in plain words, so nothing depends on the file importing cleanly. For someone standing next to you, the **QR code** is the quicker way: their camera offers *Add contact* directly. No scanning and no app needed. The contact card is inside the link (the address `/v?c=…` is public on purpose, shows only what is in the link, escapes everything, and can only ever return a plain contact card; nothing is stored, but the link contains the ticked details, so share it only with people you want to have them).
- The phone keeps the last copy it loaded, so the code still works with no signal.
- Long-press the installed app icon and choose **My QR card** for a one-tap shortcut (Android may need a day to pick it up).
- The code is a standard vCard 3.0. The more you tick, the denser the code; the app warns when it gets hard to scan.

The Worker reads and edits that one database only (`NOTION_ME_DB` in `worker/wrangler.toml`); it refuses to edit any other Notion page.

## New phone, or lost phone

Nothing is stored only on the phone except the access token and your "send straight away" choice.

1. Install the app: open the Worker address (`https://contact-capture.matthias-homan.workers.dev`) in Chrome, then menu → **Install app**.
2. Open `<that address>/#t=<your CAPTURE_TOKEN>` once. The token is saved on the phone and removed from the address bar. (Keep the token in a password manager. It is also in GitHub: repository → Settings → Secrets, though secrets can be replaced but not read; to get a new one, change `CAPTURE_TOKEN` there and re-run the deploy.)
3. Open **My QR card**. Your details come back from Notion.
4. Nothing to redo for *Save to phone contacts*: the Google permission lives in Cloudflare (the three `GOOGLE_…` secrets), not on the phone. Make sure the new phone is signed in to the same Google account.

The app itself is in GitHub and Cloudflare, and your contacts and details are in Notion, so there is nothing else to restore.

## Privacy and cost


- Photos and text are sent to the Anthropic API to be read. The Worker keeps nothing; Notion keeps only the fields it extracted. Card photos themselves are not stored anywhere.
- *Save to phone contacts* sends only the one person you tap to Google Contacts, using a permission limited to contacts that lives in Cloudflare as a secret. Revoke it any time at myaccount.google.com → Security → Third-party access.
- The access token is stored in the phone's browser storage only. To rotate it, change the `CAPTURE_TOKEN` secret, re-run the workflow, and open a new setup link on the phone.
- Reading one card costs roughly one US cent with the default model (`claude-opus-5-5`). Set `MODEL = "claude-sonnet-5-5"` in `worker/wrangler.toml` to make it cheaper.
- Card text is treated as data: the instructions to Claude say to ignore any commands printed on a card, its reply is validated field by field, and the Worker can only write the fields listed above.

## Development

```bash
cd worker
npm ci
npm run typecheck
npm test            # 107 tests: matching rules, Notion writes (against an in-memory Notion), access control, serving the app
```

Run everything locally with `npx wrangler@4 dev`, putting the three secrets in `worker/.dev.vars` (git-ignored), then open `http://127.0.0.1:8787/`.

The code is tested against a simulated Notion, a stubbed model and the real Cloudflare runtime running locally. The first real run needs checking by hand: share one card and look at the result in Notion.

## My sharing details: a row without a Type
Each row in the Notion database *My sharing details* needs a **Type** (Phone, Email, Website, Address, Company, Role …) and at least one **Group**. If a row you added by hand has no Type, the app guesses it from the value (something with an @ is an email, a link is a website, digits are a phone number); if it cannot guess, the row is listed as *Not shared* with a reminder to set the Type. Only the groups you tick on the My QR tab are shared (by default just *Professional*).

## Contact files: format notes
Contact cards (QR codes, share links, downloaded `.vcf` files) are vCard 3.0. Types are written the way Apple's own files do it (`TYPE=INTERNET;TYPE=HOME`, one parameter each). A comma-joined list (`TYPE=HOME,INTERNET`, used by versions up to v18) made Apple Contacts on the Mac stop reading the card at the email line, so only the name and first phone number arrived. The share-link service rewrites such lists on the fly, so links made by older versions open fully too. Links and websites carry a label (LinkedIn, Website …).

## The tab bar
**Add | People | Tasks | My QR** and the settings button sit in one bar fixed at the top of the screen. It stays put while you scroll a long list, and the letter headings of the People and Companies lists stick right below it, so one tap switches tabs from anywhere in the list.
