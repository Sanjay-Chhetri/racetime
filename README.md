# RaceTime

**Chip-free race timing that runs on the phones you already have.**

Volunteers scan bib QR codes at each checkpoint. The public gets a live
leaderboard with splits, category rankings and printable finisher certificates.
When you can afford RFID mats later, they plug into the same pipeline without a
rewrite.

Built for small and mid-size road races — the kind where a timing company quotes
more than the entry fees bring in. Built and run in the **Kalimpong and Pedong
hills** of West Bengal, by [Sanjay Chhetri](https://github.com/Sanjay-Chhetri).

```
Organiser  ──▶  Race admin      set up races, start list, print branded bibs
Volunteer  ──▶  Checkpoint app  scan bibs, works with no signal
Runner     ──▶  Live results    search by name, splits, category placing
Runner     ──▶  Certificate     printable keepsake with their finish time
```

---

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Trying it on a phone](#trying-it-on-a-phone)
- [Setting up a real race](#setting-up-a-real-race)
- [One event, several distances](#one-event-several-distances)
- [Runner accounts](#runner-accounts)
- [Member profiles](#member-profiles)
- [Upcoming races and entries](#upcoming-races-and-entries)
- [Virtual races](#virtual-races)
- [Workshops](#workshops)
- [Race photographs](#race-photographs)
- [Getting in touch](#getting-in-touch)
- [Telling people what happened](#telling-people-what-happened)
- [Who runs which race](#who-runs-which-race)
- [Signing in](#signing-in)
- [The landing page](#the-landing-page)
- [The results page](#the-results-page)
- [Who is looking](#who-is-looking)
- [Race admin](#race-admin)
- [Bibs and artwork](#bibs-and-artwork)
- [Finisher share cards](#finisher-share-cards)
- [How the timing stays trustworthy](#how-the-timing-stays-trustworthy)
- [Project layout](#project-layout)
- [API](#api)
- [Deploying](#deploying)
- [Race-day runbook](#race-day-runbook)
- [Security](#security)
- [Not built yet](#not-built-yet)
- [Troubleshooting](#troubleshooting)

---

## What you get

| | |
|---|---|
| **Offline capture** | Scans queue on the phone and sync when signal returns. A dead zone costs you nothing. |
| **Clock correction** | Volunteer phones are routinely seconds off. Each device measures itself against the server and corrects every scan. |
| **Append-only audit** | Every sighting is kept exactly as it arrived. Bad reads are voided, never deleted. |
| **Multiple distances** | One event can hold a 5K and a 10K, each with its own course, gun and rankings. |
| **Category rankings** | Overall, category and gender placings — *"1st of 19 in Open"* — each computed inside its own race. |
| **Branded bibs** | Upload artwork, print chest bibs with QR codes, two per A4. |
| **Finisher share cards** | A 1080 × 1350 image built for Instagram and WhatsApp, on your artwork. Runners search by name and can add their own photo. |
| **Live leaderboard** | Says whether the race is still on, how many are home and how far each runner is behind the winner. Filter by race, status, category or gender. |
| **Race photographs** | A picture of the race on its listing and across the top of its results. |
| **Runner accounts** | Runners keep their races, times, certificates, points and badges in one place, and enter races themselves. |
| **Accounts and roles** | Named sign-ins with three roles. Super admins create races and manage members; admins run them. Results and scanning stay public. |
| **RFID ready** | QR, manual entry and RFID all post the same payload to the same endpoint. |

---

## Requirements

- **Python 3.10+** (developed on 3.12)
- A modern browser
- Nothing else — SQLite is the default database and needs no setup

---

## Quick start

```bash
git clone https://github.com/Sanjay-Chhetri/racetime.git
cd racetime

python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS / Linux:
source .venv/bin/activate

pip install -r requirements.txt

python seed.py                 # optional: a 40-runner demo race
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000/>.

If you seeded, go straight to
[`/results.html#siliguri10k`](http://localhost:8000/results.html#siliguri10k) —
40 runners, three checkpoints, two DNFs, and a few deliberate messes to show how
they resolve.

> **Database migrations run automatically** when the server starts, so an
> existing `racetime.db` is upgraded in place. You never run a migration command.

### Windows note

`python3` may not exist on Windows — use `python`. If activation is blocked by
execution policy, either run the interpreter directly
(`.venv\Scripts\python.exe -m uvicorn ...`) or allow scripts for the session:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

---

## Trying it on a phone

The checkpoint app needs a camera, and **browsers only allow camera access over
HTTPS or on `localhost`**. Plain `http://192.168.x.x` will load the page but the
camera will refuse to start.

Two ways round it:

```bash
# 1. A tunnel — quickest for testing
cloudflared tunnel --url http://localhost:8000

# 2. Deploy somewhere with a certificate (see Deploying below)
```

Manual bib entry works over plain HTTP, so you can test the rest of the flow on a
phone at `http://<your-laptop-ip>:8000/checkpoint.html` without a tunnel.

---

## Setting up a real race

1. **Create the event** in Race admin (`/admin.html`). The short code you choose
   appears in every public link.
2. **Add a race per distance.** Even a single-distance event needs one — call it
   `10K`. Give it the distance in km.
3. **Add checkpoints** to each race. Every race needs exactly one marked
   `finish`. Splits are optional but make the results far more interesting.
4. **Enter the runners.** One field each for bib, name, category, gender and
   race. The bib fills in the next number, `Enter` adds the runner, and category
   and race carry over — so a start list types straight through. Category and
   gender suggest what you have already used, so `Veteran` does not become three
   divisions. For a long list, paste or upload a CSV from the collapsed section.
   Check the per-race entry counts afterwards: a whole distance imported against
   the wrong race is easy to catch there and painful to catch later.
5. **Upload artwork** and print bibs. Print *one* first and look at it.
6. **On the morning**, open the checkpoint app on each volunteer phone while you
   still have wifi, pick the checkpoint, and let the clock sync finish.
7. **Fire the gun** from Race admin as the race starts.

### CSV format

```csv
bib,name,category,gender,race
1,Tenzing Bhutia,Open,Men,10K
2,Anita Rai,Veteran,Women,10K
501,Sharon Thapa,Open,Women,5K
```

Only `bib` is required. The `race` column is matched against your race names, so
one file can cover every distance. Re-importing is safe — bibs already present
are skipped.

---

## One event, several distances

An event holds any number of **races**. "Kalimpong 5K & 10K" is one event with a
5K and a 10K: separate courses, separate finish lines, separate rankings, and
optionally separate guns for a staggered start. **Nobody is ever placed against a
field that ran a different distance.**

Every finisher gets three placings — overall, within their category, and within
their gender — each computed inside their own race and each carrying its field
size, so results can say *"1st of 19 in Open"* rather than just a number.

**Each bib prints its own runner's race**, above the number and large enough to
read across a junction: `25K` over `101`, `5K` over `301`. A race whose name has
no number in it, like "Hill Challenge", prints with the distance added. That
matters for marshalling as much as for the runner — the person at the fork has
to tell at a glance who turns left.

Two naming rules follow from how the app works:

- **Checkpoint names are unique per event**, not per race. Volunteers pick from
  one flat list on a phone, so two checkpoints called "Finish" would be a real
  hazard. Name them `5K Finish` and `10K Finish`.
- **Bibs are unique per event**, across all races, because a scan carries a bib
  and nothing else. Separate number series per race (`1–199`, `500+`) are fine.

---

## Runner accounts

Anyone can open an account at `/signup.html`. It is optional — results and
certificates stay open to everyone — but with one, a runner gets **My running**:
every race they have run, their times and placings, the certificates they have
earned, points, badges, and the entries they are waiting on.

None of it is stored. Points and badges are worked out from the scans on every
request, the same way the leaderboard is, so voiding a bad read corrects
somebody's total without a recount.

| | Points |
|---|---|
| Finishing | 10 |
| Each kilometre | 1 |
| First overall | 25 · second 15 · third 10 |
| Winning your category | 10 |
| First of your gender | 8 |

Placings only score where the placing means something — top three, and never in
the bottom half of the field. It is the same rule the finisher card uses, so a
badge and a total never disagree.

## Member profiles

A runner with an account gets a profile at **`/r/their-name`** — photo, town,
what they have run, their points and badges, all in one place.

**It is private until they choose otherwise**, every time. Race results are
public regardless, as results are; the profile is the gathering of them into a
browsable page, and that is the part somebody opts into.

**An account for someone under 18 can never be made public or members-only.**
The server refuses it; the form merely reflects that. Only a year of birth is
stored — enough for the rule and for age categories. An account with no year is
treated as an adult, so nobody who signed up earlier is reclassified.

A hidden profile answers 404 rather than 403, because a 403 would confirm the
account exists. Email, phone, emergency contact and birth year never appear on
a public profile whatever the setting.

Sign-up requires consent and records when it was given.
[`/privacy.html`](static/privacy.html) sets out what is kept and who sees it —
**placeholder text, to be replaced before taking money or opening the site
beyond people you know.**

## Upcoming races and entries

Publish a race under **Race admin → When and where** and it appears in
*Upcoming races* on the home page. Tick **Accept entries** and runners can enter
it themselves.

An entry is a **request**, not a bib. It arrives in **Race admin → Entries**,
where you confirm it and give them a number — and confirming is the moment they
join the start list under their own name. Withdrawing or rejecting takes them
back off it, so a race never runs with somebody entered who has pulled out.

A fresh install creates a published **practice event** three weeks out with
entries open, so you can walk the whole path — enter, confirm, print a bib,
scan it, see the result, collect the certificate — before a real race depends
on it. Delete it when you are done; it does not come back. `RACETIME_NO_DEMO=1`
skips it.

## Virtual races

A race nobody travels to. You announce the distances and the prices, people run
them wherever they are inside a window, and send you a photo of their watch.
Nothing else about the race changes — the same listing, the same entries, the
same certificate.

Set one up like any other race, then open the **Virtual** tab:

| Field | What it does |
|---|---|
| This is a virtual race | Turns the rest on |
| The window closes | It opens on the date under "When and where" |
| Price per distance | In rupees, one per distance, yours to set. 0 is free |
| Your UPI id and name | What entrants are told to pay |
| Your UPI QR code | Upload the one your own bank app gives you |

**There is no payment gateway and the app holds no bank or card details.**
People pay you directly by UPI and type in the reference number their app gave
them. You check it against your own account and tick it off. The QR and your
UPI id are only shown to people who have already entered.

Entrants get three ways to pay, because **you cannot scan a QR code on the
screen you are holding** and most people here have one phone: a button that
opens their UPI app with your id, the amount and a note naming them already
filled in; a button that copies your UPI id; and your QR, for anybody paying
from a second phone or a desktop.

Entrants see the price on the distance before they enter, and are asked for a
postal address — optional, only so you can post a medal, and only ever visible
to you.

### Logging runs

Each runner gets their own page at `/virtual.html#<code>`: a progress bar, how
to pay, and a form to log a run — how far, what day, how long (optional), what
they tracked it with, and a photo or screenshot.

**Every run counts the moment it is sent.** Making people wait for you before
they can log the next one is how a virtual race goes unfinished. Runs that look
odd are **flagged and still counted**, so you review a short list instead of
approving everything:

- no screenshot
- a pace over 22 km/h — quicker than the marathon world record
- one run longer than the whole race
- the same distance twice on the same day

Runs that break a *rule* rather than looking odd are refused outright, with the
reason: a date in the future, a date before the race opened, or a distance over
500 km.

In the **Virtual** tab you see the flagged ones with their screenshots. Count it
and the flag clears; reject it and the distance comes off their total. The
submission is kept either way, so you can change your mind when somebody
explains themselves.

**Progress is added up from the runs every time it is asked for, never stored.**
Reject a run two weeks later and every total is right immediately.

### Finishing

When somebody has covered the distance *and* their entry is paid for (or
waived, or free), their certificate appears on their own page — the same card
as the finisher certificate, saying **Virtual race** and carrying the distance,
with no time and no placing, because everybody ran their own course.

Then download the address list from the Virtual tab to post the medals. It has
only the people who finished and settled up.

---

## Workshops

A race happens once. A workshop is what brings people back between races — a
coaching session with a room, a register and a limit.

Open **Workshops** in race admin and add one. Only the title is required; fill
in the rest when you know it.

| Field | What it does |
|---|---|
| Start and length | Shown on the listing, soonest first |
| Mode | `in person` asks for a venue, `online` asks for a joining link |
| Host | Who is taking it |
| Capacity | Leave it **empty for no limit**. Don't put `0` — that is a different thing |
| Cover image | Used on the card and behind the certificate |
| Published | Off until you turn it on |

**Unpublished means invisible**, not greyed out: it is missing from the list and
the address answers "no such workshop". Only you can see it while you finish
writing it.

Members register from the home page. When the room is full they go on a
**waitlist** instead of being turned away, and they are told which they got.
If somebody drops out, or you raise the capacity, the next person waiting is
moved up automatically — in the order they joined.

**The joining link for an online session only reaches people who have a
place.** Not the listing, not the waitlist, not the public page. Otherwise the
capacity means nothing.

On the day, open the register in admin — it carries names and email addresses,
so you can let people in — and tick off who turned up. That is timestamped.
Nobody can tick their own name.

Anyone marked present can then download a **participation certificate** from
their own page. It is the same card as the finisher certificate but has no time
and no placing, because a workshop has neither.

One thing admin will refuse: **deleting a workshop somebody attended.**
Unpublish it instead. Deleting it would take away the evidence behind a
certificate you already gave out. An empty one deletes normally.

### Would you pay for this?

There is one question worth asking while everything is still free: what would
you pay for, and what feels fair. That is the only time the answer tells you
anything — ask afterwards and you are asking people to justify a decision you
already took.

The place to put the answers exists (`POST /api/interest`, the
`interest_answers` table, no account needed). **Nothing asks the question yet**
and there is no screen that reads the answers back — that is the next small
piece of work, not something already running. Nothing is charged anywhere in
the app.

---

## Race photographs

A race can carry a **photograph** — runners on the road, the start line, the
view. Upload it in **Race admin → Artwork**, with the bib artwork and the certificate background — all three images in one place — with an optional credit.

It leads the card in *Upcoming races* and runs across the top of the results
page: the two screens somebody reaches without knowing anything about the race.
It is a third image on purpose — the bib artwork is a printed banner and the
certificate background is a portrait card, and neither is a picture of the race.

Both places crop rather than stretch, and the block is capped, so whatever shape
you upload cannot take over the page.

## Getting in touch

The form at the bottom of the home page reaches the organiser. Messages are
**saved to the database and read in Race admin → Messages** — deliberately, so
they stay in one place instead of becoming more email. A contact form that
loses what people wrote because mail was misconfigured is worse than no contact
form, which is why the database is the record and email is only ever a copy.

If you do want copies forwarded, set `SMTP_HOST`, `SMTP_USER` and
`SMTP_PASSWORD` (and `CONTACT_EMAIL` to change the destination from
`sanjay.chhetri4u@gmail.com`).

### Telling people what happened

Four moments used to be silent, and the only way to learn about any of them was
to keep opening the website:

| When | What they get |
|---|---|
| You confirm an entry | "You are in", with their bib, distance, date and place |
| You mark a payment received, or waive it | What arrived, and the certificate if they had already finished |
| You reject a run | Which run, your reason, and where they now stand |
| They finish a distance | Either the certificate, or what is still owed |

These are about a thing that person did, so they always go — they are not the
same question as the announcements tick-box, which is for news about races
nobody has entered yet. Nobody is emailed about anybody else's entry, and an
account with no email address is skipped silently.

A reply goes to **you**, not to the server, so somebody who thinks you have
made a mistake can just hit reply.

**With no SMTP set up, none of this sends** and the Messages screen says so
plainly — because an organiser who believes entrants are being told things
nobody is telling them will not go and chase the people waiting to hear. The
app always shows the truth on screen either way; email is a copy, exactly as it
is for the contact form.

To turn it on, set `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD`, plus
`SITE_URL` so the links in the emails point at your own site rather than the
default `https://racetime-beta.vercel.app`.

---

## Who runs which race

Four admins and five races, and you do not want the person running the Pedong
race opening the Kalimpong one. Open a race, and under **Who runs this race**
tick the people who should run it.

**A race with nobody ticked can only be run by you and the other super
admins.** That is how a new race starts, so nothing is ever open by accident.
Tick two people and those two can run it; everybody else cannot see it at all.
Untick everybody and it comes back to the super admins.

Your existing races kept the admins they already had — johny and sherap
were put on all four when this arrived, so nobody lost access overnight. Races you
make from now on start closed.

| | Super admin | An admin on the race | An admin not on it |
|---|---|---|---|
| Run the race — runners, bibs, entries, artwork, payments | yes | yes | **no** |
| See who entered, with their phone and address | yes | yes | **no** |
| Even open the race in admin | yes | yes | **no** — it is not in their list |
| Decide who runs it | yes | no | no |
| Messages inbox | yes | yes | yes |
| Workshops and visitor numbers | yes | no | no |
| Create a race | yes | no | no |

Super admins are not on the tick list: they can run everything, and offering to
assign them would suggest that could be taken away. Runners have to be made
admins first, under Members.

**"Can look but not change" is deliberately not an option.** A race's entry
list carries every entrant's email, phone, emergency contact and, for a virtual
race, their home address. Looking is the part worth stopping.

Nothing about the public side changes: results, the race listing, the start
list and the photographs stay public, because they always were. And an admin is
still a person — they can enter anybody's race as a runner, log their own runs
and pay their own entry.

---

## Signing in

Organisers sign in at `/login.html` with a username and password. There are two
roles:

| | Super admin | Admin |
|---|---|---|
| Run a race — runners, checkpoints, artwork, reads, bibs | yes | yes |
| Confirm entries, read messages and visitor numbers | yes | yes |
| **Create a race** | yes | no |
| **Manage members** | yes | no |

There is a third role below both: **runner**. A runner holds an account and can
enter races and see their own record, but runs nothing — `/admin.html` is not
served to them at all.

Passwords are stored as PBKDF2-HMAC-SHA256 at 600,000 iterations. The session is
an `HttpOnly`, `SameSite=Lax` cookie backed by a row in the database, so signing
someone out — or disabling their account — takes effect on their very next
request rather than whenever a token happens to expire. `/admin.html` is not
served at all to anyone who is not signed in.

**First run** creates four accounts if the database has none:

| Username | Password | Role |
|---|---|---|
| `sanjay` | `sanjay` | Super admin |
| `sajal` | `sajal` | Super admin |
| `johny` | `johny` | Admin |
| `sherap` | `sherap` | Admin |

> **These are starting passwords, not passwords.** Each account is flagged to
> choose a new one the first time it signs in, and the app says so until it is
> done. Set `RACETIME_SEED_USERS` as `name:password:role,…` to seed different
> ones, or change them from **Members** once you are in.

## The landing page

`/` is written for runners and the people watching them. Pick a race, then
**See live results** or **Get my certificate** — that is the whole page, plus
the last few races you opened.

**How RaceTime works** is not on this page. It walks through the admin and
checkpoint screens, which a runner has no use for and a new official needs
first — so it lives in the organiser area marked *start here*, and on the
sign-in page. The page stays reachable by URL, so you can send it to a new
volunteer before their account exists.

Organiser screens are behind **Organiser sign-in** in the corner, using the same
account as Race admin, so signing in once covers both. Signed out, the page
shows a runner nothing of the organiser's, and `/admin.html` is not served at
all.

## The results page

`/results.html#<code>` is the link you share. It opens with a status line —
**Live** while anyone is still on the course, **Final** once they are all in —
the date, and a scoreboard of finishers, runners still out, DNFs and entries.

The table ranks each race separately, colours the podium, and shows every other
finisher's gap behind their race winner. Filter chips narrow by race, status,
category and gender, each with a live count. Search matches name or bib as you
type. Tapping a runner opens their splits, their placings (*"1st of 19 in
Open"*), a link to their certificate and a Share button.

It polls every ten seconds and keeps showing the last known results if the
connection drops.

## Race admin

`/admin.html` opens on your list of races. Pick one and its sections appear as
tabs — **Runners, Races, Checkpoints, Artwork, Reads** — one at a time, with
counts on the tabs and the open section in the address bar, so a reload comes
back where you were and you can link someone straight to a section.

Reads load only when you open them, fifty rows at a time, with a bib filter for
chasing down a single runner's sightings.

## Who is looking

**Race admin → Visitors** shows how many people opened the site, when, which
races they looked at, what they came from and on what kind of device.

It is counted on the server, so there is **no tracking script on any page** and
no cookie. To count people rather than requests, each visit is reduced to a hash
of the address and browser with a salt that changes at midnight — the same
person is one visitor for a day, and a different one tomorrow, so nobody can be
followed across days and nothing stored can be turned back into a person. The
table holds no IP address and no user-agent string. Rows older than 90 days are
deleted.

Because it is server-side it also counts people running an ad blocker, and it
covers the finisher certificate without a script being added to that page.

It **cannot** tell you how long anyone stayed. That needs a script reporting
back from the page, which is exactly what this avoids. Set `ANALYTICS_SALT` to
a random value in production.

## Bibs and artwork

Upload race artwork in Race admin. **PNG, JPEG or WebP, 5 MB maximum.** SVG is
refused on purpose — uploads are served from your own origin and an SVG can carry
script.

A photo straight off a phone is usually 6–12 MB, and serverless hosts refuse a
request body over about 4.5 MB at the edge, before the app can answer. So the
browser resizes anything over 3.5 MB to fit — longest edge 2000 px — and says so
when it does. A file already small enough is uploaded byte for byte.

Two bib layouts, switchable per event:

| Layout | Looks | Costs |
|---|---|---|
| **Full** (default) | Artwork edge to edge, text reversed out over a dark scrim. What runners keep. | Heavy on ink; can bleed on cheap paper |
| **Band** | Artwork in a strip at the top, number on bare paper. | Cheapest, most legible at distance |

Print one of each before committing to a few hundred. In both layouts **the QR
sits on a solid white tile** — a code printed over artwork is the usual reason a
scan fails.

Output is 180 × 132 mm per bib, two per A4 portrait sheet.

### Artwork guidance

One image feeds both the bib and the A4 certificate, each cropped from the
centre. So:

- **3000 × 2000 px (3:2)** is the sweet spot. JPEG for photographs, PNG for flat
  illustration.
- Keep the focal point **centred**; nothing important near the edges.
- Nothing important along the **bottom** — that is where the scrim is heaviest.
- **No text in the image.** The app overlays the race name itself.

---

### Stopping strangers scanning

The capture screen is open to anybody with the link, and so is the endpoint it
posts to. That is deliberate: volunteers scan without accounts, which is what
lets you hand the link to somebody at a junction and have it work.

If you would rather only your own volunteers could send scans, open the race,
go to **Checkpoints**, and press **Require a code**. You get six characters like
`K7M2PQ`. Read it out to each volunteer as you set their phone up; they type it
once and the phone remembers it for that race.

The screen checks the code before scanning starts, so nobody discovers at the
end of a morning that an hour of work could not be sent. If a code is wrong
mid-race the screen says **code wrong** rather than pretending it is a signal
problem, and every scan stays queued until it is fixed.

**Leaving it off is a reasonable choice.** A fake scan is noise you void from
the Reads tab in seconds. A volunteer who cannot send is a race with no
results.

---

## Finisher share cards

Generated after the race from the real results, so they carry the finish time
and placings — things a bib printed the night before cannot.

The output is a **1080 × 1350 image**, sized for a phone screen rather than a
sheet of paper, because this ends up in an Instagram story or a WhatsApp thread.
The finish time is by far the largest thing on it, then the runner's name, then
the event. Bib and average pace sit small in a corner with a QR back to the
results.

Finishers get **Share** and **Download** side by side. Download always works —
it never depends on the share sheet, because dismissing that used to leave a
runner with nothing at all.

A **rank badge appears only when the placing is worth sharing** — top three, and
never in the bottom half of the field, so "3rd of 4" shows nothing. Splits and
the verification URL are deliberately absent; they stay on the results page.

The certificate takes **its own background image**, separate from the bib's,
because a bib is landscape and a card is portrait. How it sits is your choice:

| Fit | What it does | Use it when |
| --- | --- | --- |
| Fill the card | Fills 4:5 and crops the rest | The image is roughly 4:5 already |
| Show the whole image | Fits all of it in, and the card takes the image's shape, up to 9:16 | You have an event poster that is taller than 4:5 |

A 1:2 poster filled to a 4:5 card loses its title and its sponsor footer to the
crop. Fitted, all of it is there, and any space it does not reach is filled with
a colour sampled from the poster's own border. Upload a tall image and Race
admin picks this for you, with a note saying why.

Runners can **add their own photo**. It is read in the browser and drawn
straight into the card — never uploaded, never stored, no endpoint for it.
Reloading the page discards it. The card is designed to look complete without
one.

Runners find themselves at `/certificate.html` **by name**, not by bib — anyone
coming back weeks later has binned the bib. The A4 certificate still prints, as
a secondary button.


## How the timing stays trustworthy

**Clock correction.** Volunteer phones are routinely several seconds off, and
that error lands straight in the split times where nothing can detect it later.
At checkpoint setup each phone measures itself against `/api/time` and corrects
every scan by the difference. The raw device time **and** the offset applied are
both stored, so a disputed result can be audited.

**Idempotent ingest.** `read_id` is a UUID generated on the device at the moment
of the scan, and it is the primary key. A phone coming back from a dead zone can
resend its whole queue as often as it likes. Reads leave the local queue only
after the server confirms, so an ambiguous failure always resolves towards
resending rather than losing data.

**Results are derived, never stored.** Splits and rankings are recomputed from
reads on every request. Void a bad read or fix a clock offset and the leaderboard
corrects itself on the next refresh — no migration, no repair job.

**One ingest shape for every source.** A QR scan, a typed bib and an RFID tag
read all post the same payload to the same endpoint. That is why RFID support is
one extra file and no changes anywhere else:

```bash
python tools/rfid_bridge.py --event siliguri10k --checkpoint 2 --simulate
```

---

## Project layout

```
backend/
  main.py         FastAPI app, every endpoint, automatic schema migrations
  models.py       15 tables. `reads` and run submissions are the record
  schemas.py      Pydantic request/response models
  timing.py       Splits and rankings, computed on demand and never stored
  achievements.py Points and badges, derived from reads on every request
  auth.py         Passwords, sessions and the three ordered roles
  analytics.py    Visitor counting, hashed daily and never identifying
  mail.py         Forwards the contact form when SMTP is configured
  notices.py      Tells a runner what happened to their own entry
  db.py           SQLite by default; DATABASE_URL switches to Postgres
static/
  index.html        Home — find a race, upcoming races, contact
  signup.html       Open a runner account
  login.html        Sign in
  me.html           A runner's own record: races, points, badges, entries
  profile.html      A runner's public profile, served at /r/<slug>
  privacy.html      What is kept and who can see it (placeholder)
  admin.html        Race admin — races, entries, start list, artwork, bibs
  checkpoint.html   Volunteer capture screen
  results.html      Public leaderboard
  certificate.html  Finisher certificate
  attended.html     Participation certificate for a workshop
  virtual.html      A runner's own virtual race: pay, log runs, finish
  guide.html        Walk-through for a new official
  js/store.js       Offline queue (IndexedDB) and clock sync
  js/theme.js       The Himalayan wallpapers
  js/cardexport.js  Shared PNG export for both certificates
  vendor/           Vendored QR library, so race day needs no CDN
tools/
  rfid_bridge.py    The upgrade path to RFID mats
docs/
  REQUIREMENTS.md   Full functional specification
tools/check_docs.py Fails if the documents have drifted from the code
seed.py             40-runner demo race
```

---

## API

Interactive docs at `/docs` while the server runs. 🔒 needs a signed-in
operator; 👤 any **signed-in account**; ⭐ a **super admin**.
Everything unmarked is public. The ones
you will actually touch:

| | Method | Path | Notes |
|---|---|---|---|
| | `GET` | `/api/time` | Clock reference for capture devices |
| | `POST` | `/api/auth/login` | Sign in; sets the session cookie |
| | `POST` | `/api/auth/logout` | Sign out |
| ⭐ | `GET` | `/api/users` | Accounts (super admin only) |
| ⭐ | `PUT` | `/api/events/{code}/operators` | Who may run this race; empty list reopens it |
| 🔒 | `GET` | `/api/analytics` | Visitor numbers |
| | `POST` | `/api/auth/signup` | Open a runner account |
| | `GET` | `/api/events/upcoming` | Published races, soonest first |
| 👤 | `GET` | `/api/me/record` | Your races, points and badges |
| 👤 | `POST` | `/api/events/{code}/register` | Enter a race |
| | `POST` | `/api/messages` | Contact form |
| | `GET` | `/api/events/public` | Code and name only, for the race pickers |
| ⭐ | `POST` | `/api/events` | Create an event |
| 🔒 | `POST` | `/api/events/{code}/start` | Fire the gun; optional `?at=` |
| 🔒 | `POST` | `/api/events/{code}/races` | One per distance |
| 🔒 | `POST` | `/api/events/{code}/checkpoints` | One per timing point |
| 🔒 | `POST` | `/api/events/{code}/participants` | JSON list |
| 🔒 | `POST` | `/api/events/{code}/participants/csv` | `bib, name, category, gender, race` |
| 🔒 | `DELETE` | `/api/participants/{id}` | Remove a runner; their reads are kept |
| 🔒 | `POST` | `/api/events/{code}/artwork` | Multipart image upload |
| | `POST` | `/api/events/{code}/reads` | Batch ingest, idempotent — **public on purpose** |
| 🔒 | `PATCH` | `/api/events/{code}/virtual` | Make a race virtual; set the window and UPI details |
| 👤 | `POST` | `/api/registrations/{reg_id}/runs` | Log a run towards a virtual race |
| 🔒 | `GET` | `/api/events/{code}/runs` | Submissions; `?status=flagged` to review |
| 🔒 | `GET` | `/api/events/{code}/shipping.csv` | Addresses for posting medals |
| 🔒 | `POST` | `/api/workshops` | Create a workshop |
| 👤 | `POST` | `/api/workshops/{slug}/register` | Take a place, or join the waitlist |
| 🔒 | `GET` | `/api/workshops/{slug}/registrations` | The register, for the day itself |
| 🔒 | `PATCH` | `/api/workshop-registrations/{reg_id}` | Mark who turned up |
| 🔒 | `GET` | `/api/events/{code}/reads` | Raw audit log |
| 🔒 | `POST` | `/api/reads/{read_id}/void` | Exclude from timing, keep the row |
| | `GET` | `/api/events/{code}/results` | Races, checkpoints and ranked results |

Full table in [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md#6-api-reference).

---

## Deploying

**HTTPS is not optional** — phone cameras will not start without it. Every option
below issues a certificate automatically.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./racetime.db` | **Required in production.** Postgres URL |
| `RACETIME_SEED_USERS` | *(unset)* | First-run accounts as `name:password:role,…`. Only used on an empty database |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |

> **Change the starting passwords before deploying anywhere public.** The
> endpoint stays open and anyone who finds the URL can create events, edit start
> lists and delete races. With it, the 19 endpoints that change a race require
> the token, while results, certificates and checkpoint scanning stay public.

### Vercel

The repo ships `vercel.json` and `api/index.py`, which wrap the same FastAPI app
the local server runs.

```bash
npm i -g vercel
vercel login
vercel link
vercel env add DATABASE_URL production     # paste your Postgres URL
vercel --prod
```

**Vercel is serverless, so Postgres is mandatory.** Provision one first — Vercel
Postgres, [Neon](https://neon.tech) and [Supabase](https://supabase.com) all have
a free tier. If `DATABASE_URL` is missing the app refuses to boot with an
explanatory error rather than silently starting from an empty SQLite file on
every cold start and losing your race.

Two things to know about this platform:

- **Cold starts.** An idle function takes a second or two to wake. Harmless for
  results browsing; noticeable if a volunteer's first scan of the morning
  triggers it.
- **Nothing may be written to disk.** Uploaded artwork is stored in the database
  for exactly this reason, so it works here unchanged.

### Railway or Render (recommended)

A better architectural fit than serverless — a long-running process, so there
are no cold starts when a volunteer's first scan of the morning arrives. The
repo carries a `Procfile` and a `render.yaml`, so neither needs any code
changes.

**Railway:** New Project → Deploy from GitHub repo → add a Postgres database.
Railway injects `DATABASE_URL` automatically and reads the `Procfile`.

**Render:** New → Blueprint → point at this repo. `render.yaml` declares both
the web service and a free Postgres instance, and wires `DATABASE_URL` between
them.

Attach a database on either. Without one the app falls back to SQLite on a disk
the platform does not keep, and warns loudly at startup that every race will be
erased on the next deploy.

Roughly ₹0–1,500 a month on any of these until you have real traffic.

---

## Race-day runbook

Learned the hard way by everyone who has ever timed a race:

1. Create the event, then a race per distance, then that race's checkpoints.
   Give every race exactly one finish, named distinctly (`5K Finish`).
2. Load the start list and check the per-race entry counts in Race admin.
3. Print bibs the night before, after printing **one** to check it on your actual
   printer. Print ten spares with high numbers for morning registrations.
4. Open the checkpoint app on each volunteer phone **while you still have wifi**,
   pick the checkpoint, and let it finish clock sync. It caches the start list,
   so it works from then on with no signal.
5. Tell volunteers to add it to their home screen and leave the screen on.
6. **Fire the gun before or as the race starts, never afterwards.** Reads that
   predate the start time produce negative elapsed times, which display as
   `0:00:00` rather than raising an error. For a staggered start, set each race's
   own start time instead of the event gun.
7. Have a backup at the finish: a phone recording video of the finish line with a
   running clock in shot. Bibs get lost, cameras fail, someone crosses carrying a
   child. Reconciling from video afterwards takes twenty minutes; having no record
   takes your race's credibility.
8. Do not publish results until you have looked at the raw reads screen. Look for
   drift warnings, unknown bibs, and anyone showing a 9 km split but no finish.

---

## Security

Signing in splits the API in three.

**Requires the token** (19 endpoints, `401` without it): listing all events,
creating an event, firing the gun, artwork, branding, every race / checkpoint /
participant write, marking DNF, the raw reads log, and voiding a read.

**Stays public:** a single event by code, its races, checkpoints, participants,
results and artwork — plus **posting reads**.

That last one is deliberate. The volunteers' capture screen and the public
results page are static files served to anyone, so neither can hold a secret.
Reads are append-only and every one can be voided, so the worst an anonymous
poster manages is noise a race director clears from the audit screen — not data
loss — and it buys a capture app that works on any phone with no setup.

In Race admin a `locked` / `unlocked` pill appears in the masthead. Click it,
paste the token once, and it is remembered in this browser. It is checked
before being stored, so a typo is caught immediately, and if the server rejects
it later the app asks again and replays what you were doing.

**The public half stays open** — deliberate, so a laptop
needs no setup. The server says so loudly at startup.

Also handled:

- Uploads are validated by **magic bytes**, not the `Content-Type` header, which
  any client can forge. SVG is refused to avoid stored XSS.
- Stored filenames are generated server-side, closing the path-traversal hole.
- Runner and event names are HTML-escaped everywhere they are rendered.
- The token is compared with `secrets.compare_digest`, so it cannot be guessed a
  character at a time by timing responses.
- Results and finisher cards are **public by design** — anyone with the event
  code can look up any runner.


## Not built yet

**SMS notifications** and **year-grouping** of events. There is **no payment
gateway** and none planned: a virtual race entry is paid by UPI between two
people, and the app records only the reference number. **Whether a medal was
actually posted** is not tracked — the address list is a CSV and the rest is
the post office. The question about what people would pay for has an endpoint
and a table but nothing that asks it.

Two gaps worth naming rather than leaving to be discovered:

- **Nobody is recorded as having made a change.** A bib changed or an entry
  confirmed is saved, but not who did it. Reads carry a full trail; nothing
  else does, and with several admins on different races that is the gap
  worth closing next.
- **Session duration is not measured.** The visitor numbers cover who, when and
  what, but not how long anyone stayed; that needs a script reporting back from
  each page, which is the thing the server-side approach avoids.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Camera will not start on a phone | Not on HTTPS or `localhost`. Use a tunnel or deploy. |
| All finish times show `0:00:00` | The gun was fired *after* the reads arrived. Elapsed went negative and clamps to zero. |
| A runner is missing from results | They are probably entered against the wrong race — check per-race counts in Race admin. |
| "Print bibs" does nothing | Open the browser console. The QR library is vendored in `static/vendor/`; if those files are missing the handler aborts. |
| `no such column` on startup | You are running an old `racetime.db` against newer code without starting through `backend.main`. Migrations run at import. |
| Deploy crashes with "DATABASE_URL is not set" | Correct behaviour on a serverless host. Provision Postgres and set the variable. |
| Artwork vanished after deploying | You are on a build from before artwork moved into the database. Re-upload it once. |
| Two checkpoints both named "Finish" rejected | Names are unique per event. Use `5K Finish` and `10K Finish`. |
| `409` on a checkpoint's order number | That sequence is already used in the same race. The message names the checkpoint holding it. |
| Everything returns `401` | Your session has ended. Sign in again at `/login.html`. |
| `ModuleNotFoundError: No module named 'psycopg'` | Your `DATABASE_URL` uses the psycopg 3 scheme. Both drivers ship now; reinstall from `requirements.txt`. |
| A page loads but nothing renders | Almost always a stale cached file. Hard-refresh once (`Ctrl+Shift+R`); the server now sends `no-cache` so it should not recur. |
| Results are empty though scans are arriving | The gun has not been fired, so there is nothing to measure elapsed time from. |

---

## Licence

No licence file yet — all rights reserved by default. Add one before inviting
contributions.
