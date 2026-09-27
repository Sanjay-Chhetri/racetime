# RaceTime

**Chip-free race timing that runs on the phones you already have.**

Volunteers scan bib QR codes at each checkpoint. The public gets a live
leaderboard with splits, category rankings and printable finisher certificates.
When you can afford RFID mats later, they plug into the same pipeline without a
rewrite.

Built for small and mid-size road races — the kind where a timing company quotes
more than the entry fees bring in.

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
- [Signing in](#signing-in)
- [The landing page](#the-landing-page)
- [The results page](#the-results-page)
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
| **Accounts and roles** | Named sign-ins with two roles. Super admins create races and manage members; admins run them. Results and scanning stay public. |
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

Two naming rules follow from how the app works:

- **Checkpoint names are unique per event**, not per race. Volunteers pick from
  one flat list on a phone, so two checkpoints called "Finish" would be a real
  hazard. Name them `5K Finish` and `10K Finish`.
- **Bibs are unique per event**, across all races, because a scan carries a bib
  and nothing else. Separate number series per race (`1–199`, `500+`) are fine.

---

## Signing in

Organisers sign in at `/login.html` with a username and password. There are two
roles:

| | Super admin | Admin |
|---|---|---|
| Run a race — runners, checkpoints, artwork, reads, bibs | yes | yes |
| **Create a race** | yes | no |
| **Manage members** | yes | no |

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

## Finisher share cards

Generated after the race from the real results, so they carry the finish time
and placings — things a bib printed the night before cannot.

The output is a **1080 × 1350 image**, sized for a phone screen rather than a
sheet of paper, because this ends up in an Instagram story or a WhatsApp thread.
The finish time is by far the largest thing on it, then the runner's name, then
the event. Bib and average pace sit small in a corner with a QR back to the
results.

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
  main.py       FastAPI app, all 24 endpoints, automatic schema migrations
  models.py     Five tables. `reads` is append-only
  schemas.py    Pydantic request/response models
  timing.py     Splits and rankings, computed on demand and never stored
  db.py         SQLite by default; DATABASE_URL switches to Postgres
static/
  index.html        Home
  admin.html        Race admin — races, checkpoints, start list, artwork, bibs
  checkpoint.html   Volunteer capture screen
  results.html      Public leaderboard
  certificate.html  Finisher certificate
  js/store.js       Offline queue (IndexedDB) and clock sync
  vendor/           Vendored QR library, so race day needs no CDN
tools/
  rfid_bridge.py    The upgrade path to RFID mats
docs/
  REQUIREMENTS.md   Full functional specification
seed.py             40-runner demo race
```

---

## API

Interactive docs at `/docs` while the server runs. 🔒 needs a signed-in
operator; ⭐ needs a **super admin**. Everything unmarked is public. The ones
you will actually touch:

| | Method | Path | Notes |
|---|---|---|---|
| | `GET` | `/api/time` | Clock reference for capture devices |
| | `POST` | `/api/auth/login` | Sign in; sets the session cookie |
| | `POST` | `/api/auth/logout` | Sign out |
| ⭐ | `GET` | `/api/users` | Accounts (super admin only) |
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

Authentication, online registration, payments, race photography, SMS
notifications, and year-grouping of events. None of them affect the data model,
so all are additive.

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
