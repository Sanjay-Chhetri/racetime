# RaceTime — Requirements and Functional Specification

**Version:** 1.3 · **Last updated:** 25 September 2026

This document describes what RaceTime does today. It is a record of built and
verified behaviour, not a wish list. Anything not yet built is confined to
[§10 Not built](#10-not-built).

---

## 1. Purpose and scope

RaceTime times running events without timing chips. Volunteers scan bib QR codes
on ordinary phones at each checkpoint; the public gets a live leaderboard, splits
and downloadable finisher certificates. RFID mats can be added later without
changing the data model.

**In scope:** event and race setup, start lists, checkpoint capture (QR, manual,
RFID), clock correction, offline queueing, split and rank computation, a public
leaderboard, printable branded bibs, shareable finisher cards, and a
shared-secret admin gate.

**Out of scope today:** user accounts, online registration, payments, race
photography, SMS or email notification. See [§10](#10-not-built).

---

## 2. Actors

| Actor | Uses | Device | Assumed conditions |
|---|---|---|---|
| **Volunteer** | `/checkpoint.html` | Phone | Often no signal; outdoors; one-handed |
| **Super admin** | `/admin.html` | Laptop | Creates races and manages who else can sign in |
| **Admin** | `/admin.html` | Laptop | Runs a race in full; cannot create one or manage people |
| **Registered runner** | `/me.html`, `/signup.html` | Phone | Enters races, keeps their own record |
| **Runner / public** | `/results.html`, `/certificate.html` | Phone or laptop | Any time during or after the race; **no account needed** |

---

## 3. Data model

`reads` is the source of truth; everything a runner sees is derived
from it on demand and never stored.

```
Event ─┬─ Race ─┬─ Checkpoint
       │        └─ Participant
       ├─ Checkpoint  (also linked directly, for event-wide queries)
       ├─ Participant (also linked directly, for bib uniqueness)
       └─ Read        (append-only)
```

### 3.1 Event

One race day at one venue.

| Field | Type | Notes |
|---|---|---|
| `code` | string(24), unique | Used in every public URL |
| `name` | string(200) | |
| `start_time` | datetime, nullable | The gun. A race may override it |
| `artwork_url` | string(255), nullable | URL the artwork is served from, with a cache-busting token |
| `artwork_blob` | binary, nullable | The image itself. Stored here, not on disk, so it survives a host with an ephemeral filesystem |
| `artwork_type` | string(32), nullable | Sniffed media type, e.g. `image/png` |
| `accent_color` | string(16), nullable | Hex; defaults to `#f2c500` |
| `tagline` | string(160), nullable | Line under the race name in print |
| `bib_style` | `full` \| `band`, nullable | Bib layout; defaults to `full` |

### 3.2 Race

One distance within an event. **This is what makes "Kalimpong 5K & 10K" a single
event rather than two.**

| Field | Type | Notes |
|---|---|---|
| `event_id` | FK → Event | Cascade delete |
| `name` | string(80) | Unique within the event, e.g. `10K` |
| `distance_km` | float | Drives pace and the distance shown on print |
| `start_time` | datetime, nullable | **Null means use the event gun.** Set it for a staggered start |
| `sequence` | int | Display order |

### 3.3 Checkpoint

| Field | Type | Notes |
|---|---|---|
| `event_id` | FK → Event | |
| `race_id` | FK → Race, nullable | Which race's course this belongs to |
| `name` | string(120) | **Unique across the whole event** — see [§9.1](#91-checkpoint-names-are-unique-per-event) |
| `distance_km` | float | |
| `sequence` | int | Orders split columns in results |
| `kind` | `start` \| `split` \| `finish` | Each race needs exactly one `finish` |

### 3.4 Participant

| Field | Type | Notes |
|---|---|---|
| `event_id` | FK → Event | |
| `race_id` | FK → Race, nullable | Which race they entered |
| `bib` | string(24) | **Unique within the event**, across all races |
| `name` | string(200) | |
| `category` | string(60), nullable | Free text: `Open`, `Veteran`, `Women 40-49` |
| `gender` | string(16), nullable | Free text; ranked separately from category |
| `dnf` | bool | Set manually; overrides a computed finish |

### 3.5 User

An operator or a runner. One table, one sign-in, three ordered roles
(`runner` < `admin` < `super_admin`) — which is why adding runners changed no
existing endpoint: every one of them already demanded "admin or above".

Passwords are a PBKDF2 digest, never a password. Runners carry an email, a
phone and a home town; operator accounts created by a super admin may carry
none of them.

### 3.6 Session

A signed-in browser, as a **row** rather than a self-contained token — a token
that cannot be withdrawn is a password with an expiry date. What is stored is
the SHA-256 of the cookie value, so a leaked backup yields no live sessions.

### 3.7 Registration

**A request to run, which is not the same thing as a bib.** Keeping the two
apart is what lets an organiser take entries for weeks, then decide the field,
assign numbers and print. Confirming a registration is the moment a
`Participant` is created, linked to the account; withdrawing or rejecting
removes it again.

### 3.8 PageView

One visit. No cookie, no IP address, no user-agent string — a hash of the
address, the browser and a salt that changes at midnight, so visitors can be
counted for a day and nobody followed across days.

### 3.9 Message

Something sent through the contact form. Written here **before** any attempt to
email it, because mail needs credentials that may not be set and a form that
loses what people wrote is worse than no form.

### 3.10 Workshop

A coaching session rather than a race: a title, when it starts, how long it
runs, whether it is `in_person` or `online`, who is taking it, and how many
places there are.

| Field | Type | Notes |
|---|---|---|
| `slug` | string(60), unique | Made from the title, so the address is readable |
| `starts_at`, `duration_minutes` | | |
| `mode` | `in_person` \| `online` | Decides whether `venue` or `meeting_link` applies |
| `venue` | string(200), nullable | Where to turn up |
| `meeting_link` | string(400), nullable | **Never sent to the public.** See FR-21.4 |
| `capacity` | int, nullable | **Null means no limit.** Zero would mean nobody may come, which is a different statement and not one anybody makes by leaving a box empty |
| `price_paise` | int | **Paise, not rupees, and not a float.** Zero until payments exist. A hundred registrations priced in floating point end up short |
| `cover_blob`, `cover_type` | | Held in the database, like race artwork — nothing is written to disk at runtime |
| `is_published`, `registration_open` | bool | Both default off and on respectively |

### 3.11 WorkshopRegistration

One person, one workshop, with a unique constraint on the pair so a double tap
cannot take two places.

`status` carries the whole story: `registered`, `waitlisted` when the room is
full, `cancelled` if they drop out, `attended` once an organiser marks them
present, `no_show` if they did not. Attendance is a **status, not a second
table**, because nobody can attend a session they never registered for — the
register *is* the list.

### 3.12 InterestAnswer

What somebody said they would pay for, asked at sign-up and again after a
workshop, optional both times, and answerable once per context. `fair_price` is
whole rupees — what a person types when asked what feels reasonable.

Asked **before** anything is for sale, which is the only point at which the
answer means anything. Afterwards you are not asking what somebody wants; you
are asking them to justify a decision already taken.

### 3.13 RunSubmission

One run somebody did on their own, offered towards a virtual race.

| Field | Type | Notes |
|---|---|---|
| `registration_id` | FK | Which entry it counts towards |
| `distance_km` | float | 0.1 to 500; outside that is a typo, not a run |
| `ran_on` | date | **A date, not a timestamp.** A screenshot shows a day, and a day has no timezone to get wrong |
| `duration_seconds` | int, nullable | Optional. Plenty of people walk a distance and do not time it |
| `source` | `app` \| `watch` \| `treadmill` \| `other` | |
| `evidence_blob`, `evidence_type` | | The photograph. **Private** — see FR-24.15 |
| `status` | `accepted` \| `flagged` \| `rejected` | Accepted **and** flagged both count; only a rejection takes a run out |
| `flags` | string, comma separated | `no-evidence`, `fast`, `long`, `duplicate` — machine written, shown to both sides |

Like a `Read`, this is a record of something that happened, and **progress is
summed from these on request and never stored**.

### 3.14 EventOperator

Which admins are allowed to run which race. One row per person per race, with
a unique constraint on the pair.

**An unassigned race is open to every admin; naming somebody closes it.** The
table is therefore empty for every race that existed before it, which is
exactly why nothing had to be migrated. Super admins are never rows in it.

### 3.15 Read — append-only

One sighting of one bib at one checkpoint. **Never edited, never deleted.**

| Field | Type | Notes |
|---|---|---|
| `read_id` | string(36), **primary key** | UUID generated *on the capture device* |
| `event_id`, `checkpoint_id`, `bib` | | |
| `observed_at` | datetime | Clock-corrected. This is what timing uses |
| `device_time` | datetime, nullable | The device's own uncorrected clock |
| `clock_offset_ms` | int | The correction applied, kept for audit |
| `server_received_at` | datetime | |
| `source` | `qr` \| `manual` \| `rfid` \| `import` | |
| `device_id` | string(64), nullable | |
| `voided` | bool | Excluded from timing; the row survives |

---

## 4. Functional requirements

### FR-1 — Events

- **FR-1.1** Create an event with a unique code and name. A duplicate code is
  rejected with `409`.
- **FR-1.2** List all events, newest first.
- **FR-1.3** Fire the gun, setting `start_time` to the server clock or to a
  supplied timestamp.
- **FR-1.4** The admin screen opens an event by picking it from a list of
  existing races, newest first. Entering the code by hand stays available as a
  fallback, and Enter in that field opens the event just as the button does.
- **FR-1.5** `GET /api/events/public` returns only each event's code and name.
  It is unauthenticated, so the pickers on the admin, checkpoint and certificate
  screens work whether or not anyone is signed in.

### FR-2 — Races

- **FR-2.1** Create any number of races within an event, each with its own name,
  distance and display order.
- **FR-2.2** Race names are unique within an event, case-insensitively. A
  duplicate is rejected with `409`.
- **FR-2.3** A race may carry its own `start_time`, which overrides the event
  gun for its runners. This is how staggered starts work.
- **FR-2.4** A race with participants still entered **cannot** be deleted;
  rejected with `409` naming the count. Deleting an empty race cascades to its
  checkpoints.
- **FR-2.5** When an event has exactly one race, checkpoints and participants
  join it automatically and no caller ever has to name it. Once there are two or
  more, omitting `race_id` is rejected with `422`.

### FR-3 — Checkpoints

- **FR-3.1** Add a checkpoint with name, distance, sequence and kind.
- **FR-3.2** `kind` must be `start`, `split` or `finish`; otherwise `422`.
- **FR-3.3** A checkpoint belongs to exactly one race (subject to FR-2.5).
- **FR-3.4** Deleting a checkpoint stops its reads counting but does not delete
  them.
- **FR-3.5** A `sequence` already used by another checkpoint **in the same
  race** is rejected with `409`, naming the checkpoint that holds it. The same
  sequence in a different race is allowed, as is a checkpoint keeping its own
  sequence through an unrelated edit.
- **FR-3.6** A checkpoint may be corrected in place via `PATCH`, rather than
  deleted and recreated.

### FR-4 — Participants (start list)

- **FR-4.1** Runners are added one at a time through a form with **one field
  per value** — bib, name, category, gender, race. The bib is pre-filled with
  the next number, `Enter` in any field submits, and category, gender and race
  persist between entries while the name clears.
- **FR-4.1a** Category and gender offer back values already used in the event,
  so one division does not fracture into several spellings.
- **FR-4.1b** The full start list is displayed, not summarised as a count, and
  each row can be removed. Removing a runner keeps their reads, which reappear
  if the bib is re-added.
- **FR-4.1c** Bulk entry by pasted `bib, name, category, gender` lines remains
  available in a collapsed section.
- **FR-4.2** Import a CSV with header columns `bib, name, category, gender,
  race`. Only `bib` is required. A `race` value is matched against race names, so
  **one file can cover every distance**; an unrecognised race name is rejected
  with `422` naming the offending bib.
- **FR-4.3** Bibs already present in the event are skipped, making import
  re-runnable.
- **FR-4.4** A runner may be marked DNF, which overrides any computed finish.

### FR-5 — Checkpoint capture

- **FR-5.1** A volunteer picks an event and a checkpoint once; the choice
  persists in `localStorage`.
- **FR-5.2** The device measures its clock against `/api/time` at setup and
  corrects every subsequent scan by the offset. The raw device time **and** the
  offset are both stored.
- **FR-5.3** The camera scans bib QR codes. Payload format is
  `RT|<event-code>|<bib>`; a bare number is also accepted, so bibs printed
  elsewhere still work.
- **FR-5.4** Repeat scans of the same bib within **8 seconds** collapse to one
  sighting at capture. This is a convenience guard only — the server still keeps
  every read it receives.
- **FR-5.5** A bib may be typed manually.
- **FR-5.6** Every scan is written to IndexedDB and acknowledged immediately. A
  separate loop drains the queue whenever a connection exists. Reads leave the
  local queue **only after the server confirms**, so an ambiguous failure always
  resolves towards resending rather than losing data.
- **FR-5.7** The start list is cached, so the app names the runner with no signal.

### FR-6 — Timing and ranking

- **FR-6.1** Results are computed from reads on every request and never stored.
  Voiding a bad read or correcting a clock offset fixes the leaderboard on the
  next refresh, with no repair job.
- **FR-6.2** Where a bib was seen several times at one checkpoint, the
  **earliest non-voided** read wins.
- **FR-6.3** Start time precedence, highest first:
  1. an individual read at a `start` checkpoint (wave starts),
  2. the runner's race `start_time`,
  3. the event `start_time`.
- **FR-6.4** Status is derived: `finished` (a finish read exists),
  `on_course` (some split but no finish), `dnf` (flag set), `not_started` (no
  sightings).
- **FR-6.5** **Every ranking is computed within a single race.** A 5K runner is
  never placed against the 10K field.
- **FR-6.6** Three independent placings per finisher, each with its field size:
  `position`/`field_size` (overall in race), `category_position`/`category_size`,
  and `gender_position`/`gender_size`.
- **FR-6.7** A runner with no category or no gender recorded receives no placing
  for that dimension, rather than being grouped into a bogus division.
- **FR-6.8** Pace per kilometre is computed per split and averaged over the
  race's distance for the certificate.

### FR-7 — Public results (`/results.html#<code>`)

- **FR-7.1** Polls every 10 seconds. Polling is deliberate: results change
  slowly and a poll survives a flaky connection with no reconnection logic.
- **FR-7.2** Live search by name **or** bib, filtering as the user types, with
  the matched characters highlighted.
- **FR-7.3** Filter chips with live counts for **race**, **status**,
  **category** and **gender**. Race chips appear only when the event has more
  than one race; category and gender chips only when more than one value
  exists. Status chips appear only for statuses that actually occur.
- **FR-7.4** Selecting a race rescopes the category and gender chips and counts
  to that race, and resets both filters, since a value present in one race may
  not exist in another.
- **FR-7.5** Sort by rank, bib, name or finish time, ascending or descending.
  **Runners with no finish time always sort last, in both directions.**
- **FR-7.6** The top three in each race are colour-coded, **and only they are**.
  Every finisher's rank used to be painted in the accent colour, which left the
  podium shades indistinguishable from the other thirty rows; ranks from fourth
  down are muted.
- **FR-7.6a** When more than one race is shown at once, the table is **banded by
  race**, each band carrying the race name, distance and entry count. Ranks
  restart at 1 inside each band because each race is placed separately; without
  the bands that reads as a fault. Bands are dropped when a race filter is
  applied or the table is sorted by anything other than position.
- **FR-7.6b** The bib has its own column at the same weight as on the finisher
  card. At phone widths the row becomes rank / bib / name / time, and never
  wraps.
- **FR-7.7** Tapping a runner reveals their placings (*"1st of 19 in Open"*),
  every split with distance, elapsed and pace, a link to their certificate, and a
  Share button.
- **FR-7.8** Share uses the device's native share sheet where available and
  falls back to copying to the clipboard.
- **FR-7.9** A **status header** states whether the race is `Live`, `Final` or
  `Not started`, with the date. It is `Final` only once **every entrant has
  reached a terminal state** (finished or DNF) — not merely when nobody is on
  course, since a runner with no sightings at all counts as `not_started`, and a
  race whose gun had fired but whose checkpoints had scanned nobody was
  reporting itself finished. The page is reached
  by a shared link, often mid-race, and the name alone does not say whether the
  numbers are still moving.
- **FR-7.10** A **scoreboard** of finishers, still running, did not finish and
  entered. Counts that do not apply are omitted rather than shown as zero.
- **FR-7.11** The last column shows, for a finisher, the **gap behind the
  winner of their race** (`+1:25`, or `winner`); for a runner still out, the
  last checkpoint they passed; otherwise their status. It previously printed the
  last checkpoint for everyone, which on a finished race is the word "Finish" on
  every row.

### FR-7b — Landing page (`/`)

- **FR-7b.1** The page is aimed at **runners and spectators**, who are almost
  everyone who opens it. It previously listed five identical panels in the order
  the screens were built, with *Race admin* above both of the things a runner
  came for.
- **FR-7b.2** One control carries the page: pick a race, then **See live
  results** or **Get my certificate**. Both buttons stay disabled until a race
  is chosen. A server holding a single race preselects it.
- **FR-7b.3** The picker is filled from `GET /api/events/public`, so it works
  whether or not the server is gated.
- **FR-7b.4** The last three races opened are offered again on return. This is
  a per-browser convenience in `localStorage`; every read and write is guarded
  and the page renders correctly without it.
- **FR-7b.5** **Organiser screens are hidden behind a sign-in.** Race admin,
  Checkpoint and the run-through appear only once an organiser signs in, and
  the state persists.
- **FR-7b.6** Sign-in uses the **same token and storage key as the admin
  screens**, so signing in here carries over to them.
- **FR-7b.7** Signed out, the organiser section is absent and the page offers
  only a link to `/login.html`. Signed in, it names the role and tailors what
  Race admin is described as doing.
- **FR-7b.8** The page asks the server who it is talking to; it never decides
  from anything held in the browser.
- **FR-7b.9** The **walk-through is not linked from the runner's page**. It
  explains the admin and checkpoint screens, which a runner has no use for, and
  is the first thing a new official needs — so it sits in the organiser area
  marked *start here*, and on the sign-in page for someone who has an account
  but has not used it yet. The page itself is left ungated: it holds no race
  data, and it is what you send a new volunteer before their account exists.
- **FR-7b.10** The footer names the region the app is run in and credits its
  author.

### FR-7a — Race admin layout (`/admin.html#<code>[/<section>]`)

- **FR-7a.1** The event's sections are **tabs**: Runners, Races, Checkpoints,
  Artwork, Reads. One panel renders at a time. As one page it ran to 16,000px,
  with Runners — the screen used on the morning — below three sections that are
  set once and never revisited.
- **FR-7a.2** The open section is part of the address (`#siliguri10k/runners`),
  so a reload returns to it, back and forward move between sections, and a link
  can point at one. An unrecognised section falls back to Runners.
- **FR-7a.3** Tabs carry **counts** (runners, races, checkpoints, reads), so the
  page says what is in it without being opened.
- **FR-7a.4** Arrow keys move between tabs, Home and End jump to the ends, and
  only the open tab is in the page's tab order.
- **FR-7a.5** **Reads are fetched only when their tab is opened**, and drawn 50
  rows at a time behind a "Show more", with a bib filter. Rendering all 200 at
  once was most of the old page's height for a screen only opened when something
  looks wrong.
- **FR-7a.6** Opening a race **hides the chooser**; "switch race" in the event
  bar brings it back.
- **FR-7a.7** Destructive actions in a table row are **quiet** — text weight,
  no fill, colour only on hover. A full outlined red button per row made Remove
  the most prominent thing on a roster of forty runners.

### FR-8 — Race artwork and printable bibs

- **FR-8.1** Upload artwork per event. **PNG, JPEG or WebP only, 5 MB maximum.**
  The bib and the certificate hold **separate** images; see
  [FR-9.13](#fr-9--finisher-card-certificatehtml) for how the certificate's is fitted.
- **FR-8.1a** Serverless hosts reject a request body over ~4.5 MB at the edge,
  where the app's own limit and its JSON error never apply — the operator saw a
  bare status code. The browser therefore resizes any file over 3.5 MB (longest
  edge 2000 px, JPEG, quality stepped down until it fits) and reports the change.
  A file already under the threshold is uploaded unaltered, so a deliberately
  prepared PNG keeps its transparency and its exact bytes.
- **FR-8.2** The file type is determined by **inspecting magic bytes**, not the
  declared `Content-Type`. SVG is refused — see [§8.2](#82-no-svg-uploads).
- **FR-8.3** The image is stored **in the database**, never on disk. The uploaded
  filename is discarded, which also closes the usual path-traversal hole. The
  serving URL carries a random token for cache-busting, so it can be cached
  immutably and a new upload still takes effect immediately.
- **FR-8.4** Replacing artwork overwrites the stored bytes in a single
  transaction; there is no orphaned file to clean up.
- **FR-8.5** Accent colour and tagline are set independently of the image. A
  partial update never clears a field it did not mention.
- **FR-8.6** Two bib layouts, selectable per event:
  - **`full`** (default) — artwork across the whole bib, text reversed out white
    over a four-stop dark scrim that guarantees contrast whatever the image.
  - **`band`** — artwork confined to a strip at the top, number on bare paper.
    Far cheaper to print and the most legible at distance.
- **FR-8.7** With no artwork uploaded, the bib falls back to `band` regardless of
  setting, because full-bleed with no image is a flat wash of colour.
- **FR-8.8** **In both layouts the QR sits on a solid white tile.** A code
  printed over artwork is the usual cause of a failed scan.
- **FR-8.9** Print output is 180 × 132 mm per bib, two per A4 portrait sheet.
- **FR-8.10** The distance printed on a bib is derived from the race, so it can
  never drift out of step with the course.
- **FR-8.11** A live preview shows a real bib, using the first runner on the
  start list where one exists.

### FR-9 — Finisher card (`/certificate.html`)

- **FR-9.1** A race is chosen from a dropdown of all events. A single event
  selects itself rather than presenting a list of one.
- **FR-9.2** One search box matches **name or bib**, filtering live, with the
  match highlighted. Name is the primary route: a runner returning weeks later
  has thrown the bib away.
- **FR-9.3** Non-finishers remain listed but disabled, labelled with the reason
  (`did not finish`, `still running`, `no sightings`), so searching your own name
  never returns an unexplained blank.
- **FR-9.4** The list caps at 40 rows with a prompt to narrow the search.
- **FR-9.5** The primary output is a **1080 × 1350 px (4:5) share card**, sized
  for a phone screen rather than a sheet of paper. Hierarchy, largest first:
  finish time, runner name, then event name with distance and date. Bib number
  and average pace sit small in a corner alongside a QR to the public results.
- **FR-9.6** A rank badge appears **only when the placing is an achievement** —
  top three, and never in the bottom half of the field, so "3rd of 4" shows
  nothing. Overall rank is preferred; category rank is the fallback.
- **FR-9.7** Deliberately **absent** from the card: the split list, the
  verification URL as text, and any placing that fails FR-9.6. All of it remains
  on the results page.
- **FR-9.8** A runner may add their own photo. It is read with `FileReader` and
  drawn straight into the card: **never uploaded, never stored**, with no
  endpoint, column or table for it. Reloading discards it. It is cover-fitted
  into a circle above the name with a ring in the accent colour, and can be
  removed again.
- **FR-9.9** The card is composed for the **no-photo case first**; the photo is
  an addition, not a hole being filled.
- **FR-9.10** Export renders the card through `html2canvas` at its full size
  after awaiting `document.fonts.ready`, then offers it via `navigator.share()`
  where files are supported, falling back to a download.
- **FR-9.13** **How the artwork sits** is the organiser's choice, `cert_fit`:
  - `cover` (the default, and what every event did before) fills the card and
    crops whatever does not fit.
  - `contain` fits the whole image in. An event poster is rarely 4:5 — a 1:2
    banner filled to the card loses its title and its sponsor footer — so this
    keeps all of it.
- **FR-9.14** Under `contain` the **card takes the artwork's shape**, between
  4:5 and 9:16. Fitting a 1:2 poster into a fixed 4:5 card would leave a narrow
  strip with wide bands; matching its shape means it fills the width instead.
  9:16 is the ceiling because it is as tall as a phone shows without shrinking.
- **FR-9.15** Whatever the fitted image does not reach is filled with a colour
  **sampled from the artwork's own outer pixels**, so the join does not read as
  one. It is resolved before the card is exported, never after, or a saved PNG
  could carry accent-coloured bands the preview never showed.
- **FR-9.16** Race admin measures a chosen certificate image and, when it is
  much taller than the card (ratio above 1.45), pre-selects `contain` and says
  why. It is a suggestion; the dropdown still decides.
- **FR-9.11** The A4 certificate is still generated and remains printable, but
  is a secondary action rather than the main path.
- **FR-9.12** Deep links work: `/certificate.html#<code>/<bib>`.

### FR-10 — Accounts, authentication and authorisation

The shared `ADMIN_TOKEN` is gone. One secret that every operator pasted into
`localStorage` could not say who did something, could not be taken away from
one person without changing it for everybody, and gave a volunteer exactly the
powers of the race director.

**Identity**

- **FR-10.1** Operators are rows in a `users` table: username (unique,
  lower-cased), display name, password digest, role, active flag, and a
  "must change password" flag.
- **FR-10.2** Passwords are stored as **PBKDF2-HMAC-SHA256**, 600,000
  iterations, 16-byte random salt, verified with `hmac.compare_digest`. The
  stored string carries its own parameters, so the iteration count can be
  raised later and existing hashes still verify — and are re-hashed silently on
  the owner's next sign-in, the one moment the plaintext is available.
- **FR-10.3** bcrypt and argon2 are better algorithms and are **deliberately
  not used**: both are compiled dependencies, and a wheel that does not match
  the serverless runtime is a deployment that never boots. PBKDF2 from the
  standard library cannot fail to install.
- **FR-10.4** Login failures give **one message for every cause**. Saying "no
  such user" would let anyone enumerate the accounts.

**Sessions**

- **FR-10.5** Sessions are **rows, not self-contained tokens**. A token that
  cannot be withdrawn is a password with an expiry date; a row can be deleted,
  which signs that browser out immediately and everywhere.
- **FR-10.6** The database stores the **SHA-256 of the token**, never the
  token, so a leaked backup does not hand over live sessions.
- **FR-10.7** The cookie is `HttpOnly` (JavaScript cannot read it, so an
  injected script cannot steal it), `SameSite=Lax` (which blocks the cross-site
  POST that CSRF depends on), and `Secure` whenever the request arrived over
  HTTPS or the host is a known serverless platform.
- **FR-10.8** Sessions last 12 hours — a race day, not a fortnight — and the
  expiry slides while someone is working, but is only rewritten every 2 hours
  so a busy screen does not write to the database on every request.
- **FR-10.9** Expired rows are purged on each successful login.

**Roles**

- **FR-10.10** Two roles, ordered: `admin` < `super_admin`. A dependency takes
  the minimum required and compares by index, so "admin or above" is one
  comparison and adding a role later does not mean revisiting every endpoint.
- **FR-10.11** **super_admin** may do everything, and only they may
  **create an event** or reach **member management**.
- **FR-10.12** **admin** may run a race completely — races, checkpoints,
  participants, artwork, branding, DNF, voiding reads, printing bibs — but may
  not create an event or manage accounts.
- **FR-10.13** Refusals distinguish `401` ("say who you are") from `403`
  ("I know who you are, and no").

**Member management (super admin only)**

- **FR-10.14** List, create, edit, disable and delete accounts. A created
  account is flagged to choose its own password on first sign-in.
- **FR-10.15** **Disabling an account deletes its sessions**, so it is cut off
  mid-request rather than at the next expiry.
- **FR-10.16** A password reset also deletes that account's sessions, because a
  reset usually means the account may be compromised.
- **FR-10.17** You cannot demote, disable or delete **yourself**, and the
  **last active super admin** cannot be demoted, disabled or deleted by anyone.
  Locking every super admin out of their own system is a support call nobody
  can answer.
- **FR-10.18** A password may never equal its username, and is at least 8
  characters.
- **FR-10.19** Changing your own password requires the current one and
  **signs out every other browser**, since the usual reason to change a
  password is suspecting someone else has it.

**Enforcement**

- **FR-10.20** `GET /admin.html` is **served only to a signed-in operator**;
  otherwise it answers `303` to `/login.html?next=…`. Hiding a screen in the
  browser is decoration — the server has to refuse it. The page is also sent
  `Cache-Control: no-store` so no shared proxy keeps a copy.
- **FR-10.21** The browser hides what an account may not do — the create-race
  form, the Members tab — but **every check is repeated on the server**. The UI
  only avoids offering a dead end.
- **FR-10.22** Hiding a tab uses the `hidden` attribute, and `.tab[hidden]`
  carries an explicit `display: none`, because a class that sets `display`
  overrides the attribute and the tab would otherwise stay on screen.
- **FR-10.23** Still **public by design**: a single event by code, its races,
  checkpoints, participants, results, artwork, `/api/time`, `/api/health`,
  `/api/events/public`, and **POST reads**. The capture screen and the results
  page are static files served to anyone and cannot hold a secret. Read ingest
  stays open as a conscious tradeoff — reads are append-only and voidable, so
  the worst case is noise a race director clears, not data loss.

**Seeding**

- **FR-10.24** On a database with no accounts at all, four are created:
  `sanjay` and `sajal` as super admins, `johny` and `sherap` as admins, each
  with its username as the password and **flagged to change it on first use**.
  Seeding never runs against a non-empty table, so it cannot overwrite a
  password someone has since changed.
- **FR-10.25** `RACETIME_SEED_USERS` overrides the defaults as
  `name:password:role,…`.

### FR-11 — Audit

- **FR-11.1** Every read is visible newest-first with bib, checkpoint, time,
  source and clock drift. Drift over 2 seconds is flagged. The listing requires
  the admin token.
- **FR-11.2** A read may be **voided**, excluding it from timing while keeping
  the row. There is no delete.


---

### FR-12 — Himalayan wallpapers

- **FR-12.1** Five wallpapers — Kanchenjunga dawn, Cloud forest, Monsoon,
  Clear night, Plain dark — chosen from swatches and remembered per browser in
  `localStorage`.
- **FR-12.2** **No photographs.** The sky is a gradient and the range is two
  flat shapes cut by an inline SVG mask: under a kilobyte, no network request.
  A photograph would look better for about the two seconds it takes a phone on
  hill data to fetch it, on a page people open at a finish line.
- **FR-12.3** One pair of shapes serves every theme; the colours are custom
  properties, so a new wallpaper is five variables and no new assets.
- **FR-12.4** The sky is painted on `<html>`, not `<body>`: body is a centred
  column with a max-width, and a background there leaves bare gutters on a wide
  screen.
- **FR-12.5** Applied from a two-line inline script in `<head>`, before first
  paint. A module is deferred, so doing it in the module would show the default
  colours and then jump.
- **FR-12.6** Only pages that opt in carry `data-wallpaper`. The **finisher
  certificate does not**, because it is exported as an image and must keep
  exactly the background the organiser uploaded.
- **FR-12.7** Panels over a wallpaper stay at 88% opacity with a small blur, so
  they remain readable in sunlight at a finish line.

### FR-13 — Visitor analytics

- **FR-13.1** Visits are counted **on the server**, in the middleware that
  already runs. No tracking script is added to any page — which also means the
  finisher certificate is measured without being edited, and that the count is
  unaffected by ad blockers, a large share of the audience on a results page.
- **FR-13.2** **No cookie is set and no identifier outlives a day.** To count
  people rather than requests, each visit is reduced to
  `sha256(daily_salt + ip + user_agent)`, truncated to 32 characters. The same
  person on the same day is one visitor; tomorrow they are a new one. Nothing
  stored can be turned back into an address. `ANALYTICS_SALT` sets the salt.
- **FR-13.3** The table holds **no raw IP address and no user-agent string** —
  only the hash, the path, a bare referring hostname, and `phone`/`tablet`/
  `desktop`.
- **FR-13.4** Only pages are counted, not stylesheets, scripts or icons, which
  would be thirty rows a visit saying nothing. Requests are counted only when
  the response succeeded: a `404`, or the redirect to sign-in, is not a read.
- **FR-13.5** Known crawlers are excluded by user agent.
- **FR-13.6** A page's race code lives in the URL **fragment**, which browsers
  never send. The race is therefore attributed from the `results` API call the
  page makes next, attached to that visitor's most recent view rather than
  added as a row, so one visit stays one visit.
- **FR-13.7** Recording is best-effort and wrapped: a failed count must never
  turn into a `500` on a results page mid-race.
- **FR-13.8** Rows older than **90 days** are deleted; a super admin can prune
  on demand.
- **FR-13.9** The screen shows visits, visitors, visits per day, a daily
  series with quiet days included rather than skipped, time of day **converted
  to the reader's timezone**, and the top races, pages, referrers and devices.
- **FR-13.10** Readable by **any signed-in operator** — knowing how many people
  are watching is part of running a race and names nobody. Pruning is super
  admin only. Anonymous callers get `401`.
- **FR-13.11** **Session duration is not measured**, and the screen says so.
  It would need a script on the page reporting back, which is the thing being
  avoided.

### FR-14 — Runner accounts

- **FR-14.1** A third role, `runner`, sits **below** `admin` in the same
  ordered list. Because every existing endpoint already demanded "admin or
  above", adding it required no change to a single one of them.
- **FR-14.2** Anyone may open a runner account at `/signup.html`. The role is
  **hard-coded on the server, never read from the body** — a public form that
  accepted a role field would be a public form for making super admins.
- **FR-14.3** Usernames and emails are unique; emails are lower-cased on the
  way in so one address cannot become two accounts.
- **FR-14.4** `/admin.html` checks the **role**, not merely that somebody is
  signed in. A runner is redirected to their own page rather than asked to sign
  in again — they already are.
- **FR-14.5** A runner's page shows their races, finish times, placings, points,
  badges, certificates and entries. Nothing is stored: it is derived from reads
  on every request, the same as the leaderboard, so voiding a bad scan corrects
  a total with no recount job.

### FR-15 — Points and achievements

- **FR-15.1** Finishing earns 10 points, plus 1 a kilometre. First overall adds
  25, second 15, third 10. Winning a category adds 10; first of a gender, 8.
- **FR-15.2** Placing points use the **same test as the finisher card** — top
  three and never in the bottom half of the field — so a field of four does not
  mint three champions, and a badge on a card never disagrees with a total.
- **FR-15.3** Every score is returned **with its reasons**, so a total is shown
  as a breakdown rather than a number a runner has to take on trust.
- **FR-15.4** Eight badges, from a first finish to a hundred kilometres. All
  derived; none stored.

### FR-16 — Upcoming races and entries

- **FR-16.1** An event carries `starts_at`, `location`, `description`,
  `entry_note`, `is_published` and `registration_open`. `starts_at` is the date
  on the poster; `start_time` remains the gun, fired on the morning.
- **FR-16.2** **Nothing is public until published**, so a race can be set up
  over several sittings without half of it appearing on the site.
- **FR-16.3** Entries cannot be opened on an unpublished race — the interface
  refuses it rather than accepting entries nobody can find.
- **FR-16.4** `GET /api/events/upcoming` is public and lists published events
  soonest first, with the entry count and — for a signed-in runner — their own
  status.
- **FR-16.5** **A registration is a request; a Participant is a bib.** Keeping
  them apart is what lets an organiser take entries for weeks, then decide the
  field, assign numbers and print. Confirming a registration is the moment the
  start-list entry is created, linked to the account.
- **FR-16.6** Confirming **requires a bib**, and refuses one already taken.
- **FR-16.7** Withdrawing, rejecting or un-confirming **removes the start-list
  entry**, so a race never runs with somebody entered who has pulled out.
- **FR-16.8** A runner may withdraw their own entry; an organiser may withdraw
  anyone's. One entry per person per event — changing your mind edits the row.
- **FR-16.9** An emergency contact is collected. It is a name and a number to
  ring, not a medical record, and that is the only reason it is kept.

### FR-16a — Race photographs

- **FR-16a.1** An event may carry a **photograph**, uploaded on the **Artwork**
  screen beside the other two images. It was first placed with the date and
  place, which is where it logically belongs and not where anybody looked:
  three image uploads, two of them together and one elsewhere, is a search.
  *When and where* points at it instead. It is a **third image on purpose**: the bib
  artwork is a printed banner and the certificate background is a portrait
  card, and neither is a picture of runners on the road — which is what makes a
  listing worth opening.
- **FR-16a.2** It appears on the **upcoming-races card** and across the top of
  the **results page**, the two screens people reach cold.
- **FR-16a.3** An optional credit line is shown over the image.
- **FR-16a.4** Stored in the database like the other two images, magic-byte
  sniffed, and resized in the browser before upload when it exceeds the
  platform's request limit.
- **FR-16a.5** Both places **crop rather than stretch** (`object-fit: cover`)
  and the block is capped, so a tall or very wide photograph cannot take over
  the page.
- **FR-16a.6** Removing it returns both screens to their plain form.

### FR-17 — Contact form

- **FR-17.1** Anyone may write in, signed in or not.
- **FR-17.2** The message is **written to the database first and emailed
  second**. Mail needs credentials that may not be set; a form that silently
  drops what somebody wrote because SMTP was misconfigured is worse than no
  form.
- **FR-17.2a** On this deployment **forwarding is deliberately off**: messages
  are read in Race admin rather than in an inbox, which keeps them in one
  place. The admin banner states this as the arrangement it is, not as a fault
  to be corrected — SMTP remains available for anyone who wants copies sent on.
- **FR-17.3** Email goes to `CONTACT_EMAIL`, with the sender in `Reply-To` and
  never in `From` — the address is unverified, and forging `From` is how mail
  ends up in a spam folder.
- **FR-17.4** The inbox is readable by any signed-in operator and by nobody
  else.

### FR-18 — The practice event

- **FR-18.1** A published `demo` event is created once on an empty database:
  three weeks out, two races, entries open. Created **only if absent** and never
  touched again, so an organiser can rename, edit or delete it without it
  reappearing on the next deploy. `RACETIME_NO_DEMO=1` skips it.
- **FR-18.2** Failing to create it never prevents the app from starting.

### FR-19 — Member profiles

- **FR-19.1** A registered runner has a profile: photo, town, a short bio, the
  year they started running, preferred distances, an optional Strava link, and
  their race history and badges pulled from results.
- **FR-19.2** **Private is the default and stays the default.** Visibility is
  `private` / `members` / `public`, set to private at sign-up every time. A
  profile carries a real name, a face and a home town; somebody who has not
  chosen to publish that has not published it.
- **FR-19.3** **An account for someone under 18 can never be public or
  members-only.** The server refuses the change and the read refuses the
  profile, whatever the stored setting says. The form disables the options and
  explains why, but the rule lives on the server. RaceTime already times a
  school event; a browsable page of a child's name, face, town and movements is
  not something to leave to a toggle.
- **FR-19.4** Age is held as a **year of birth only** — enough for the rule and
  for age categories, less than a full date, which there is no reason to hold.
  An account with no year is treated as an adult, so accounts predating the
  field are not silently reclassified as children.
- **FR-19.5** A hidden profile answers **404, not 403**. A 403 would confirm the
  account exists, which is itself something the owner did not publish.
- **FR-19.6** A public profile carries **no email, phone, emergency contact or
  birth year**, whatever the visibility setting. Those exist for an organiser to
  reach somebody.
- **FR-19.7** Operators can always see a profile, because somebody has to be
  able to.
- **FR-19.8** Each runner gets a readable shareable address, `/r/<slug>`,
  derived from their name rather than their row id — `/r/47` tells whoever
  receives it how many accounts exist.
- **FR-19.9** Sign-up **requires consent** and records the time it was given;
  it is not a checkbox that can be re-interpreted later. `/privacy.html` sets
  out what is kept, what is public, and the under-18 rule.
- **FR-19.10** A Strava link must be a Strava URL, and opens with
  `rel="noopener noreferrer"` because it is user-supplied.
- **FR-19.11** Members may opt in to announcements. Nothing is sent without it.

### FR-20 — Certificates are downloadable, not only shareable

- **FR-20.1** The finisher card offers **Share** and **Download** side by side.
  Download always works and never depends on the share sheet.
- **FR-20.2** Previously the only action opened the native share sheet where
  available; **dismissing it left the runner with nothing**, and there was no
  plain download at all. A finisher should not lose their certificate to a
  stray tap.
- **FR-20.3** A dismissed share says where the file still is, rather than
  failing silently; a share that fails for any other reason falls through to a
  download.

### FR-21 — Workshops

A race is a one-day event with a start list. A workshop is a session with a
room, a register and a limit, and the thing that turns a one-off runner into
somebody who comes back.

- **FR-21.1** An operator creates a workshop with a title, a start, a length,
  a mode (`in_person` or `online`), a host, a capacity and a cover image. Only
  the title is required; a session can be put up and filled in later.
- **FR-21.2** A workshop is **unpublished when created**. Unpublished means
  absent from the public list and `404` on direct access — not greyed out.
  An operator sees it in their own list, because otherwise setting one up means
  guessing at its address.
- **FR-21.3** The address is a slug made from the title
  (`hill-running-basics`), de-duplicated with a numeric suffix.
- **FR-21.4** **The joining link for an online session goes only to people who
  hold a place, and to operators.** Not to the public list, not to the public
  detail response, and not to the waitlist. Publishing it would make the
  capacity decorative.
- **FR-21.5** A signed-in member takes a place. When the room is full they are
  **waitlisted** rather than refused, and told which they got.
- **FR-21.6** Registering twice is `409`. The unique constraint on
  (workshop, person) is the guarantee; the check is the courtesy.
- **FR-21.7** **A cancellation promotes the waitlist in the order people joined
  it**, which is the only order anybody would accept. So does raising the
  capacity. So does removing the capacity altogether, which admits everybody
  waiting.
- **FR-21.8** The public sees places taken, places left and how many are
  waiting. Knowing a session is full before registering is worth more than the
  surprise.
- **FR-21.9** The register, with names and email addresses, is for operators
  only — `401` to the public, `403` to a runner. An organiser needs to be able
  to reach the room.
- **FR-21.10** An operator marks attendance, and it is **timestamped**, not
  just flagged. A runner cannot mark their own: `403`.
- **FR-21.11** **A workshop somebody attended cannot be deleted** — `409`, with
  the instruction to unpublish it instead. Deleting it would delete the
  evidence behind a certificate already issued. An empty one deletes cleanly.
- **FR-21.12** Capacity, publication and registration can all be changed after
  the fact, and the counts and the waitlist follow.

### FR-22 — Participation certificates (`/attended.html#<slug>`)

- **FR-22.1** Somebody marked present at a workshop can download a
  participation certificate, built on the same card and the same export path as
  the finisher card: 1080 × 1350, **Share and Download side by side**, after
  `document.fonts.ready`.
- **FR-22.2** It is **deliberately not the same shape of thing as a race
  card**. There is no time and no placing, because a workshop has neither, and
  a card with blanks where those would go reads as a race somebody failed.
- **FR-22.3** **It exists only once an organiser has marked the person
  present.** Not a refusal to be worked around — the certificate's whole claim
  is that somebody was there, so the person who can say that is the person who
  ran the session.
- **FR-22.4** Signed out, the page sends them to sign in and returns them to
  the certificate afterwards, rather than showing nothing.

### FR-23 — What people would pay for

- **FR-23.1** One optional question: what would you pay for, what feels fair,
  anything else. Recorded against the account when there is one, and
  **answerable without one**, because the people worth asking include the ones
  who have not signed up.
- **FR-23.2** Asked while everything is free. That is the only point at which
  the answer is information rather than a negotiation — afterwards you are
  asking somebody to justify a decision already taken.
- **FR-23.3** **Partly built.** The endpoint and the table exist and are
  tested. No screen asks the question and no screen reads the answers back, so
  nothing is collected in practice yet. Recorded here as a foundation, not as a
  working feature.
- **FR-23.4** It will not be a condition of anything. Skipping it must block no
  screen.

### FR-24 — Virtual races

A race nobody travels to. The organiser announces distances and prices, people
run them wherever they are inside a window, and send a photograph of the watch.

**It is a flag on an event, not a second kind of thing.** `Event.is_virtual`,
with the distances as `Race` rows and the entries as `Registration` rows, so
the listing, the entry form, the admin screens and the certificate already
work. A parallel "virtual event" model would have doubled all of them.

- **FR-24.1** **The distances and the prices belong to the organiser**, set per
  race (`Race.price_paise`), not chosen by the app. One event may charge the
  same for 25K and 100K and another may not; neither is RaceTime's business.
- **FR-24.2** The window is `starts_at` to `ends_at`. Entering after it closes
  is refused whatever the entries switch says — there is no longer any time in
  which to run it.
- **FR-24.3** **The price is snapshotted onto the entry** when somebody enters
  (`Registration.amount_paise`). A price that goes up next week does not change
  what an existing entrant owes.
- **FR-24.4** Money is held in **paise, as integers**. A hundred entries priced
  in floating-point rupees end up short.
- **FR-24.5** **No payment gateway and no card or bank details.** People pay
  the organiser directly by UPI, by scanning a QR the organiser uploaded
  themselves. The app records the reference number the payer reports; the
  organiser's own statement is the proof.
- **FR-24.6** `unpaid → claimed → paid | waived`. **An entrant can claim, never
  confirm** — a self-service "I have paid" button that counted is an honour
  system with a spreadsheet attached. Only an operator sets `paid` or `waived`.
- **FR-24.7** **The UPI handle and the QR reach somebody who has entered, and
  operators. Nobody else.** They are not on the public event response, not on
  the listing, and not on an open image URL. A collection handle on an open
  page is an invitation to print your own version of the race.
- **FR-24.8** A run carries a distance, a date, an optional time, what it was
  tracked with, and a photograph or screenshot.
- **FR-24.9** **Runs are accepted on arrival.** A virtual race that makes
  people wait for a human before logging the next run is one nobody finishes.
- **FR-24.10** Implausible runs are **flagged and still counted**: no
  screenshot, a pace over 22 km/h (faster than the marathon world record), a
  single run longer than the whole race, or the same distance twice on one day.
  The runner is told which, so they can fix a typo themselves.
- **FR-24.11** **The window and the calendar refuse rather than flag.** A run
  dated tomorrow, or before the race opened, or over 500 km, is `422` with the
  reason. Those are rules, not judgements.
- **FR-24.12** **Progress is summed from the submissions on every request and
  never stored** — the same rule as results. Rejecting a run two weeks later
  changes a status, and the next read gives the new answer; there is nothing to
  recalculate and nothing that can disagree with the evidence.
- **FR-24.13** An organiser may clear a flag or reject a run. **A rejected run
  keeps its row.** A race that deletes somebody's evidence cannot answer a
  question about it afterwards.
- **FR-24.14** A runner may delete their own submission, because the usual
  reason is typing 50 for 5. An operator may delete any.
- **FR-24.15** **The evidence is private** to the runner and the operators. It
  is a picture of where somebody was and when, often with the road outside
  their house on it. Results are public; this is not.
- **FR-24.16** A certificate needs **the distance done *and* the entry
  settled**. A free race needs only the distance.
- **FR-24.17** **No bib and no start list.** Confirming a virtual entry needs
  no bib and creates no `Participant`, because there is no start line at which
  to identify anybody.
- **FR-24.18** A postal address is asked for **only by a virtual race, only to
  post a medal, and is optional**. It reaches operators and nobody else: not a
  profile, not a public event, not a results page.
- **FR-24.19** `GET /api/events/{code}/shipping.csv` lists **only finishers who
  have settled**. A list of everybody who entered is a list of parcels nobody
  owes.
- **FR-24.20** An event with live entries **cannot have the virtual flag turned
  off** — `409`, with the instruction to close entries instead.
- **FR-24.21** **Paying must work on one phone.** You cannot scan a QR code
  on the screen you are holding, and most entrants here have one device. The
  payment panel offers, in this order: a `upi://pay` intent link with the
  payee, amount, currency and a note naming the payer and the race already
  filled in; a button that copies the UPI id; and the QR, labelled for use
  from a second phone. The intent link opens an app on Android and may do
  nothing on a desktop or on iOS, which is why the other two stay.
- **FR-24.22** **Entering while signed out must not lose the race.** "Enter
  this race" sends a signed-out visitor to `/signup.html?next=/?enter=<code>`,
  and signing up returns to the listing with that race's form already open.
  `next` is followed only when it is a same-origin path, like login's. It used
  to drop them on their own empty page, and finding the race again is a step
  some of them would not take.
- **FR-24.23** **The site has to say what a virtual race is.** Four numbered
  steps appear on the card, in the entry form at the moment the decision is
  made, and on the runner's own page: run it in your own time over as many
  runs as you like, use any watch or app, send a photo of each result, finish
  the distance and the certificate is yours. Nobody in Kalimpong has run a
  race that works like this.
- **FR-24.24** The runner's own page is `/virtual.html#<code>`: progress, how
  to pay, a form to log a run, the runs so far, and the certificate when it is
  due. The card says **Virtual race** and carries the distance — **no time and
  no placing**, because everybody ran their own course.

### FR-25 — Telling people what happened

Four decisions were silent, and an entrant could only learn of them by
reloading the site: an entry confirmed or rejected, a payment received or
waived, a run rejected, a distance finished.

- **FR-25.1** Each of those sends one email to the person it is about.
- **FR-25.2** **These are transactional, not announcements.** They are about a
  thing this person did, so `announcements_opt_in` does not gate them —
  consenting to hear about your own entry is not the same question as
  consenting to be told about future races. The opt-in still governs
  announcements.
- **FR-25.3** **A notice only goes when something changed.** Marking an
  already-paid entry paid again, or re-confirming a confirmed entry, sends
  nothing. Logging more runs after finishing does not repeat the congratulations.
- **FR-25.4** **One email per moment.** Settling a payment for somebody who had
  already covered the distance says both things in one message rather than
  sending two.
- **FR-25.5** A rejected run carries the organiser's own note. When there is no
  note it says so rather than inventing a reason, and a rejection never reads
  like good news.
- **FR-25.6** **`Reply-To` is the organiser, not the server.** Somebody who
  thinks a decision is wrong replies to a person who can change it.
  `Auto-Submitted: auto-generated` keeps these out of vacation-responder loops.
- **FR-25.7** **Nothing here can stop a decision being saved.** The row is
  committed first and the notice is queued as a background task, so an SMTP
  server that hangs for fifteen seconds does not make an organiser wait to find
  out their own click worked. Failures are returned, never raised.
- **FR-25.8** With SMTP unset every notice is a quiet no-op, and **the admin
  screen says plainly that nothing is being sent** — an organiser who believes
  entrants are being notified will not chase the ones waiting to hear.
- **FR-25.9** An account with no email address is skipped, and that is not
  treated as an error.
- **FR-25.10** Composing a notice and sending it are separate: the composers are
  plain functions over plain values, with no ORM object, database or network, so
  what the email says is tested directly. That is where this kind of bug lives.

### FR-26 — Who runs which race

Four admins and five races. An admin brought in to run one of them should not
hold the others, and "view only" is not a lesser version of that: a race's
entry list carries every entrant's email, phone, emergency contact and, for a
virtual race, their home address.

- **FR-26.1** A race can have named operators. **While nobody is named, every
  admin can run it** — which is how every race behaved before this existed,
  so nothing broke when it arrived and there was no migration to get wrong.
- **FR-26.2** **Naming somebody closes the race.** From then on only the people
  named, and the super admins, may touch it. Emptying the list opens it again.
  That makes assignment the thing an organiser does, rather than a mode to
  turn on first.
- **FR-26.3** **Super admins are never scoped and never listed.** They create
  races and manage accounts; scoping them would let an organisation lock itself
  out of its own event. Assigning one is refused, because offering it implies
  it could be taken away.
- **FR-26.4** An admin who is not on a race gets **403 on every race-level
  endpoint of it** — no read and no write. The refusal names the race and says
  to ask a super admin, because somebody holding two of five races needs to
  know which door they just hit.
- **FR-26.5** **The scope is a dependency on the route, not a line in the
  handler.** There are more than thirty race-level endpoints; a check forgotten
  in one of them is not a bug, it is a hole. A route either carries a scope or
  it is named, with a reason, in a list the suite reads — see
  [11](#11-verification-performed).
- **FR-26.6** `GET /api/events` returns **only the races this operator may
  run**, so the picker offers two of five rather than five with three locked.
  A race somebody cannot open is not information.
- **FR-26.7** A race's **public face is untouched**: the results, the start
  list, the photograph and the listing stay public, because they always were.
  Scoping applies to the organiser's screens.
- **FR-26.8** **An admin is also a person.** Entering somebody else's race as a
  runner, logging their own runs and paying their own entry remain theirs to do
  in any race.
- **FR-26.9** Only a **super admin** may read or change who runs a race.
- **FR-26.10** A runner cannot be assigned, and is told to be made an admin
  first. Nor can a disabled account.
- **FR-26.11** **The screen says which state it is in.** "Nobody assigned" and
  "nobody allowed" look identical in a column of unticked boxes, so the panel
  spells out that an unassigned race is open to every admin.
- **FR-26.12** Site-wide screens are not race-scoped, so they were placed by
  hand: the **one shared inbox stays open to every admin**, while the
  **workshops and the visitor numbers moved to super admin** — an admin
  brought in to run one race does not inherit the site with it.

## 5. Non-functional requirements

| # | Requirement |
|---|---|
| **NFR-1** | Capture works with **no network**. Scans queue locally and sync when a connection returns. |
| **NFR-2** | Ingest is **idempotent**. `read_id` is a device-generated UUID and the primary key, so a queue may be resent any number of times. |
| **NFR-3** | **One ingest shape for every source.** QR, manual entry and RFID post identical payloads to one endpoint — which is why RFID support is a single extra file. |
| **NFR-4** | The capture screen must be legible outdoors in sunlight and operable with one thumb. |
| **NFR-5** | Results are derived, never stored, so corrections need no migration. |
| **NFR-6** | Print output uses `print-color-adjust: exact` so browsers do not strip backgrounds. |
| **NFR-7** | Runner names are HTML-escaped everywhere they are rendered, since they arrive from pasted text and uploaded CSVs. |
| **NFR-8** | SQLite by default with zero setup; `DATABASE_URL` switches to Postgres with no code change. A legacy `postgres://` prefix is normalised automatically. |
| **NFR-9** | Schema migrations run automatically at import and are idempotent, including a one-time move of any legacy on-disk artwork into the database. |
| **NFR-10** | **Every timestamp leaving the API is UTC-aware.** SQLite does not persist tzinfo, and a bare timestamp is parsed by JavaScript as *local* time, which showed IST users a gun time five and a half hours out. |
| **NFR-11** | Static responses send `Cache-Control: no-cache, must-revalidate`. Without an explicit directive a browser caches heuristically and can run a stale page against fresh JavaScript, which throws on load and renders nothing. |
| **NFR-12** | On serverless the database engine uses `NullPool`. Invocations do not share memory, so the usual pool becomes one private pool per concurrent invocation and exhausts the connection limit. |
| **NFR-13** | Both Postgres drivers ship. SQLAlchemy selects one from the URL scheme, and providers differ over `postgresql://` versus `postgresql+psycopg://`. |
| **NFR-14** | Database constraint violations are answered as `409` with a readable message, never as a bare 500 whose body is plain text. |
| **NFR-15** | **Nothing is written to the filesystem at runtime.** The app therefore runs unchanged on a serverless host. On Vercel it refuses to boot without `DATABASE_URL` rather than silently starting from an empty SQLite file on each cold start. |

---

## 6. API reference

👤 marks a route needing any **signed-in account**; 🔒 one needing an
**operator** (admin or super admin); ⭐ one needing a **super admin**. Anything
unmarked is public. A route that needs a session
answers `401` without one, and `403` when the account is signed in but lacks
the role. Interactive docs at `/docs` while the server runs.

### Clock and health
| | Method | Path | Purpose |
|---|---|---|---|
| | `GET` | `/api/time` | Reference clock for capture devices |
| | `GET` | `/api/health` | Liveness |
| | `GET` | `/api/admin/check` | Is this server protected, and is this token valid |

### Events
| | Method | Path | Purpose |
|---|---|---|---|
| | `POST` | `/api/auth/login` | Username and password for a session cookie |
| | `POST` | `/api/auth/logout` | Delete the session row |
| 👤 | `GET` | `/api/auth/me` | The signed-in account and its permissions |
| 👤 | `POST` | `/api/auth/password` | Change your own; signs out other browsers |
| | `POST` | `/api/auth/signup` | Open a runner account; the role is fixed server-side |
| 👤 | `GET` | `/api/me/profile` | Your own account |
| 👤 | `PATCH` | `/api/me/profile` | Your details, bio, visibility and Strava link |
| | `GET` | `/api/profiles/{slug}` | A runner's public profile; 404 when it may not be seen |
| | `GET` | `/api/profiles/{slug}/avatar` | Their photo, subject to the same rule |
| 👤 | `POST` | `/api/me/avatar` | Upload your profile photo |
| 👤 | `DELETE` | `/api/me/avatar` | Remove it |
| ⭐ | `GET` | `/api/users` | List accounts |
| ⭐ | `POST` | `/api/users` | Create an account |
| ⭐ | `PATCH` | `/api/users/{user_id}` | Role, active flag, password reset |
| ⭐ | `DELETE` | `/api/users/{user_id}` | Remove an account |
| 🔒 | `GET` | `/api/events` | List every event |
| | `GET` | `/api/events/public` | Code and name only, for the race pickers |
| ⭐ | `POST` | `/api/events` | Create (`409` on duplicate code) |
| | `GET` | `/api/events/{code}` | One event, with races and checkpoints |
| 🔒 | `POST` | `/api/events/{code}/start` | Fire the gun; optional `?at=` |
| | `GET` | `/api/events/upcoming` | Published races, soonest first, with entry counts |
| 🔒 | `PATCH` | `/api/events/{code}/schedule` | Date, place, description, publish, open entries |

### Branding
| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | `POST` | `/api/events/{code}/artwork` | Upload artwork (multipart) |
| 🔒 | `DELETE` | `/api/events/{code}/artwork` | Remove artwork |
| | `GET` | `/api/events/{code}/artwork` | Serve the stored image |
| 🔒 | `PATCH` | `/api/events/{code}/branding` | Accent colour, tagline, bib layout |
| 🔒 | `POST` | `/api/events/{code}/certificate-artwork` | Upload the certificate background |
| 🔒 | `DELETE` | `/api/events/{code}/certificate-artwork` | Remove it; the bib artwork is used again |
| | `GET` | `/api/events/{code}/certificate-artwork` | Serve the stored image |
| 🔒 | `POST` | `/api/events/{code}/photo` | Upload the race photograph |
| 🔒 | `DELETE` | `/api/events/{code}/photo` | Remove it |
| | `GET` | `/api/events/{code}/photo` | Serve the stored photograph |

### Races
| | Method | Path | Purpose |
|---|---|---|---|
| | `GET` | `/api/events/{code}/races` | List |
| 🔒 | `POST` | `/api/events/{code}/races` | Create (`409` on duplicate name) |
| 🔒 | `PATCH` | `/api/races/{race_id}` | Update |
| 🔒 | `DELETE` | `/api/races/{race_id}` | Delete (`409` if runners entered) |

### Checkpoints
| | Method | Path | Purpose |
|---|---|---|---|
| | `GET` | `/api/events/{code}/checkpoints` | List |
| 🔒 | `POST` | `/api/events/{code}/checkpoints` | Create (`409` on duplicate name or sequence) |
| 🔒 | `PATCH` | `/api/checkpoints/{cp_id}` | Update |
| 🔒 | `DELETE` | `/api/checkpoints/{cp_id}` | Delete |

### Participants
| | Method | Path | Purpose |
|---|---|---|---|
| | `GET` | `/api/events/{code}/participants` | Start list |
| 🔒 | `POST` | `/api/events/{code}/participants` | Add a JSON list |
| 🔒 | `POST` | `/api/events/{code}/participants/csv` | Import CSV |
| 🔒 | `PATCH` | `/api/participants/{pid}` | Correct a runner |
| 🔒 | `DELETE` | `/api/participants/{pid}` | Remove a runner; their reads are kept |
| 🔒 | `POST` | `/api/events/{code}/participants/{bib}/dnf` | Mark DNF |

### Entries

| | Method | Path | Purpose |
|---|---|---|---|
| 👤 | `POST` | `/api/events/{code}/register` | Enter a race |
| 👤 | `GET` | `/api/me/registrations` | Your own entries |
| 👤 | `POST` | `/api/registrations/{reg_id}/withdraw` | Withdraw; an organiser may withdraw anyone's |
| 🔒 | `GET` | `/api/events/{code}/registrations` | Every entry for a race |
| 🔒 | `PATCH` | `/api/registrations/{reg_id}` | Confirm (needs a bib), reject or reopen |

### Workshops

| | Method | Path | Purpose |
|---|---|---|---|
| | `GET` | `/api/workshops` | Published workshops, soonest first; operators also see unpublished ones |
| | `GET` | `/api/workshops/{slug}` | One workshop; `404` if unpublished and you are not an operator |
| | `GET` | `/api/workshops/{slug}/cover` | The cover image |
| ⭐ | `POST` | `/api/workshops` | Create one; unpublished until you say otherwise |
| ⭐ | `PATCH` | `/api/workshops/{slug}` | Edit; raising the capacity promotes the waitlist |
| ⭐ | `DELETE` | `/api/workshops/{slug}` | `409` if anybody attended — unpublish instead |
| ⭐ | `POST` | `/api/workshops/{slug}/cover` | Multipart image upload |
| 👤 | `POST` | `/api/workshops/{slug}/register` | Take a place, or join the waitlist |
| 👤 | `POST` | `/api/workshop-registrations/{reg_id}/cancel` | Drop out; promotes the next person waiting |
| 👤 | `GET` | `/api/me/workshops` | Your own places, waitlist spots and attendance |
| ⭐ | `GET` | `/api/workshops/{slug}/registrations` | The register, with contact details — operators only |
| ⭐ | `PATCH` | `/api/workshop-registrations/{reg_id}` | Mark present or absent; timestamped |
| | `POST` | `/api/interest` | What somebody would pay for; no account needed |

### Virtual races

| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | `GET` | `/api/events/{code}/virtual` | The virtual settings, including how to pay — **not** part of the public event |
| 🔒 | `PATCH` | `/api/events/{code}/virtual` | Make it virtual, set the window and the UPI details |
| 🔒 | `POST` | `/api/events/{code}/payment-qr` | Upload the organiser's own UPI QR image |
| 👤 | `GET` | `/api/events/{code}/payment-qr` | The QR, to somebody who has entered, or an operator |
| 🔒 | `DELETE` | `/api/events/{code}/payment-qr` | Remove it |
| 🔒 | `PATCH` | `/api/races/{race_id}` | Also sets `price_paise` — the price per distance |
| 👤 | `GET` | `/api/registrations/{reg_id}/payment` | What this entrant owes and where to send it |
| 👤 | `POST` | `/api/registrations/{reg_id}/payment` | The entrant reports a reference number |
| 🔒 | `PATCH` | `/api/registrations/{reg_id}/payment` | The organiser marks it paid, or waives it |
| 👤 | `POST` | `/api/registrations/{reg_id}/runs` | Log one run; multipart, with the screenshot |
| 👤 | `GET` | `/api/registrations/{reg_id}/runs` | The runs on this entry |
| 👤 | `GET` | `/api/runs/{run_id}/evidence` | The screenshot. The runner and operators, nobody else |
| 👤 | `DELETE` | `/api/runs/{run_id}` | A runner removing their own mistake |
| 🔒 | `PATCH` | `/api/runs/{run_id}` | Clear a flag, or reject a run |
| 🔒 | `GET` | `/api/events/{code}/runs` | Every submission; `?status=flagged` to review |
| 🔒 | `GET` | `/api/events/{code}/shipping.csv` | Addresses for posting medals, finishers only |

### Who runs which race

| | Method | Path | Purpose |
|---|---|---|---|
| ⭐ | `GET` | `/api/events/{code}/operators` | Who runs this race, and which admins could |
| ⭐ | `PUT` | `/api/events/{code}/operators` | Replace that list; an empty list reopens the race to every admin |

### Messages

| | Method | Path | Purpose |
|---|---|---|---|
| | `POST` | `/api/messages` | Contact form; saved first, emailed second |
| 🔒 | `GET` | `/api/messages` | The inbox, newest first |
| 🔒 | `PATCH` | `/api/messages/{msg_id}` | Mark done or unread |
| 🔒 | `GET` | `/api/mail/status` | Whether SMTP is configured, and where copies go |

### Visitors

| | Method | Path | Purpose |
|---|---|---|---|
| ⭐ | `GET` | `/api/analytics` | Visits, visitors, pages, races, referrers, devices |
| ⭐ | `POST` | `/api/analytics/prune` | Delete rows past the retention window |

### Reads and results
| | Method | Path | Purpose |
|---|---|---|---|
| | `POST` | `/api/events/{code}/reads` | Batch ingest, idempotent — **public**, see [§8.1](#81-why-read-ingest-is-open) |
| 🔒 | `GET` | `/api/events/{code}/reads` | Raw audit log |
| 🔒 | `POST` | `/api/reads/{read_id}/void` | Exclude from timing, keep the row |
| | `GET` | `/api/events/{code}/results` | Races, checkpoints and ranked results |
| 👤 | `GET` | `/api/me/record` | Your races, points and badges, derived on request |

## 7. Screens

| Screen | Path | Audience | Needs an account |
|---|---|---|---|
| Home | `/` | Everyone | no |
| Starter guide | `/guide.html` | Anyone new to the app | no |
| Race admin | `/admin.html#<code>` | Organiser | **yes** — operator only, and not served to a runner at all |
| Checkpoint capture | `/checkpoint.html` | Volunteer | no |
| Live results | `/results.html#<code>` | Public | no |
| Finisher card | `/certificate.html#<code>/<bib>` | Runner | no |
| My running | `/me.html` | Runner | yes |
| Participation certificate | `/attended.html#<slug>` | Somebody marked present | yes |
| My virtual race | `/virtual.html#<code>` | Somebody who has entered it | yes |
| Runner profile | `/r/<slug>` (serves `/profile.html`) | Public, members or nobody | no |
| How your details are used | `/privacy.html` | Anyone | no |
| Create an account | `/signup.html` | Runner | no |
| Sign in | `/login.html` | Operator or runner | no |

---

## 8. Security posture

### 8.1 Why read ingest is open

A shared-secret gate protects every endpoint that changes a race
([FR-10](#fr-10--admin-authentication)). Five reads and one write stay public on
purpose, because the two apps that need them cannot hold a secret: the
volunteers' capture screen and the public results page are static files served
to anyone who asks.

`POST /api/events/{code}/reads` being public is a conscious v1 tradeoff. Reads
are append-only and every one of them can be voided, so the worst an anonymous
poster can achieve is noise a race director clears from the audit screen. That
is not data loss, and it buys a capture app that works on any phone with no
setup. If a race ever needs it closed, the capture app would need a per-device
key issued at checkpoint setup.

### 8.1a Credential handling

Session tokens and password digests are compared with `hmac.compare_digest`, so
neither can be recovered a character at a time by timing responses. The session
token never reaches JavaScript — it is an `HttpOnly` cookie — and the database
holds only its SHA-256, so a leaked backup yields no usable session. Passwords
are PBKDF2-HMAC-SHA256 at 600,000 iterations with a per-account salt.

The remaining gap is **the checkpoint screen**: volunteers scan without an
account, so `POST /reads` is open. Reads are append-only and voidable, so the
worst case is noise a race director clears from the audit screen. Closing it
properly means per-device credentials issued at checkpoint setup.

### 8.2 No SVG uploads
Uploads are served from the application's own origin. An SVG can carry script, so
accepting one would grant stored XSS on every page that displays the artwork.
Raster formats only, verified by magic bytes rather than the client-supplied
`Content-Type` header, which anyone can forge.

### 8.3 Generated filenames
Stored artwork filenames are generated server-side. A client-supplied filename is
the classic path-traversal vector and is never used.

### 8.4 Output escaping
Runner and event names are HTML-escaped at every render site.

### 8.5 Public results
Results and certificates are **public by design** — anyone may look up any runner
and print their certificate. Race results are normally public, but note that this
also exposes each runner's name and category to anyone with the event code.

---

## 9. Known constraints

### 9.1 Checkpoint names are unique per event
Not per race. Volunteers choose a checkpoint from one flat list on their phone, so
two checkpoints both called "Finish" would be a genuine race-day hazard. Name them
`5K Finish` and `10K Finish`.

### 9.2 Bibs are unique per event
Across all races, because a scan carries a bib and nothing else. Races may still
use separate number series (`1–199` for the 10K, `500+` for the 5K).

### 9.3 A gun set after the fact reads as zero
If the event start time is set *later* than reads that already exist, elapsed
times go negative and display as `0:00:00` rather than raising an error. Set the
gun before or during the race, not after.

### 9.4 Category and gender are free text
Ranking groups on the exact string, so `Women` and `women` are two divisions.
The add-runner form offers back values already used in the event, which stops
most drift, but a CSV import bypasses that and nothing normalises case.

### 9.5 Artwork is cropped differently in each place
One image feeds a 180 × 132 mm bib and an A4 portrait certificate, both
`cover`-cropped from the centre. Compose with the focal point centred and nothing
important near the edges or along the bottom, where the scrim is heaviest.
Recommended source: **3000 × 2000 px (3:2)**, JPEG for photographs.

### 9.6 Printed output is unverified
On-screen appearance is now checked in a real browser at several widths (§11).
What no automated check can cover is **paper**: ink coverage, bleed on cheap
stock, and whether a QR scans once printed. Print one bib and one card on the
actual printer before committing to a run.

### 9.7 No audit of who changed what
Named accounts and three ordered roles replaced the shared token (FR-10). What
is missing is the next layer: an organiser confirms an entry or changes a bib
and the row does not record which account did it. Reads carry a full audit
trail; nothing else does.

Races can now be given named operators (FR-26), so a second organiser holds
their own race rather than all of them. What is still global is the role
itself: an account is an admin everywhere or nowhere, and being on one race
does not make somebody an admin, it only limits one. The audit gap above is
the part that remains.

---

## 10. Not built

| Area | Status |
|---|---|
| Payment gateway | Not built, and not planned for now. Virtual race entries are paid by UPI QR between two people; the app records a reference number and no card or bank details (FR-24.5) |
| Shipping status | Not built. The address list is a CSV; whether a medal was posted is not tracked |
| Strava / GPS import | Not built. Evidence would be a photograph or a screenshot |
| The interest question | Half built — endpoint and table exist, nothing asks it |
| Audit of admin actions | Not built for anything but reads |
| Year grouping of events | Not built. Only useful across multiple seasons |
| SMS / email notification | Not built. The contact form sends one way |
| Checkpoint device credentials | Not built. Ingest is open on purpose, see [8.1](#81-why-read-ingest-is-open) |
| Age-group awards | Partially covered by category ranking |

None of these require a data-model change; all are additive.

---

## 11. Verification performed

> These documents are checked against the source, not trusted. Run
> `python tools/check_docs.py` after changing the API: it fails if a route,
> page or environment variable is undocumented, if a requirement number is
> duplicated, if a README section is missing from the contents, or if a claim
> has been contradicted by the code. It has caught all four.

Everything below was run against a real browser or a live server, not reasoned
about. Anything not listed here is unverified. At the last count the suites
carry **720 assertions** — 432 against the API, 288 driving a real
browser — all passing, and each one is repeatable: they reset the accounts and
rows they touch, because a suite that only passes the first time is a suite that
will lie to you on the second. Three suites had to be mended to earn that
second run: one read a database nobody was writing to, one assumed the first
race in a list was its own, and one assumed a password another suite rotates.

| Area | Method | Result |
|---|---|---|
| **Authorisation** | 50 checks over the API | anonymous refused `401`; an admin refused event creation and member management `403`; a super admin allowed |
| | password handling | wrong password `401` with the same message as an unknown user; change requires the current one and ends other sessions |
| | session lifecycle | disabling an account cuts it off mid-request; sign-out revokes; cookie `HttpOnly` and `SameSite=Lax` |
| | the last super admin | cannot be demoted, disabled or deleted, by themselves or anyone |
| **Roles in the browser** | Chromium, 36 checks across all three roles | a runner sees no Members tab and no create-race form, and `/admin.html` is not served to them at all |
| **Runner accounts** | 53 checks | sign-up cannot set its own role; entries are requests until confirmed; confirming needs an unused bib and creates the start-list entry; withdrawing removes it |
| **Points** | purpose-built two-runner race | winner 40 (10 finish + 5 km + 25 overall), second 15; the breakdown returned with the total |
| **Contact form** | with no SMTP configured | message stored, response honest that mail is not set up, inbox refused to the public and to runners |
| **Visitors** | 26 checks | crawlers and static files not counted; a repeat visitor counted once a day; no IP or user-agent column; yesterday's hash differs from today's |
| **Runner entry** | Chromium, 13 checks | keyboard entry, bib auto-advance, suggestions, inline duplicate refusal, removal |
| **Share card** | Chromium, 21 checks across both states | export exactly 1080 × 1350; name and time legible in a 200 px thumbnail |
| | photo | cover-fit, circular, removable, never uploaded |
| **Results row** | Chromium at 360 / 414 / 768 / 1280 px | uniform 43.7 px rows, no wrapping, no horizontal overflow |
| **Race bands** | multi-race event | bands shown with name, distance and count; dropped when one race is filtered |
| **Checkpoint change** | Chromium with a fake camera, 12 checks | resume on reload, confirmation, cancel, camera released, different checkpoint selectable |
| **Checkpoint sequence** | 7 cases | duplicate in same race `409` naming the holder; same sequence in another race allowed |
| **Constraint errors** | duplicate checkpoint and race names | `409` with readable JSON, not a plain-text 500 |
| **Timezones** | 11 endpoints | 17 timestamps, 0 naive |
| **Multi-race ranking** | purpose-built 5K + 10K event, 6 checks | 5K winner not ranked against the 10K field; staggered start honoured |
| **Uploads** | SVG content named `.png`, declared `image/png` | rejected `422` by magic-byte sniff |
| **Escaping** | `<img src=x onerror=…>` as a runner name | rendered inert |
| **Migrations** | booted against a database with the **old** schema — columns and index dropped, a legacy row left behind | columns restored, booleans backfilled, seeding not repeated; reproduces the outage below without the fix |
| **Workshops** | 34 checks over the API | unpublished is `404` to the public and listed to an operator; the joining link reaches a registered member and not a waitlisted one; the third person into a room of two is waitlisted |
| | the waitlist | a cancellation and a raised capacity each promote the next person waiting, in the order they joined |
| | the register | `401` to the public, `403` to a runner marking their own attendance; attendance timestamped |
| | deletion | a workshop somebody attended refuses `409` and says to unpublish instead; an empty one deletes |
| **Workshops in the browser** | Chromium, 23 checks | the listing, the register, the waitlist notice, and the participation certificate exported at 1080 × 1350 |
| | a certificate before attendance is marked | not rendered; the page says it appears once an organiser marks them present |
| **Virtual races** | 91 checks over the API | the price is snapshotted at entry and does not follow a later rise; a claim is not a payment; the UPI handle and QR refuse the public and a signed-in non-entrant |
| | run submissions | flagged for no screenshot, 60 km/h, a duplicate day; refused for a future date, a date before the window, 900 km |
| | progress | summed from submissions; rejecting a run removes its distance on the next read |
| | the certificate | released by distance **and** settlement; an unpaid finisher gets none until the fee is paid or waived |
| | evidence and addresses | screenshot `403` to another runner and `401` to the public; the address list `403` to a runner and absent from every public response |
| **Virtual races in the browser** | Chromium, 86 checks | organiser sets it up, runner enters, pays by reference, logs three runs, is queried on one, finishes, and the card renders 1080 × 1350 with no time on it |
| | the public event response | checked field by field for a UPI handle after one was found on it |
| **Taking part** | Chromium at 390 px, 45 checks | a first-time visitor taps Enter, signs up, comes back to the open form, reads the four steps, enters, pays and logs a run on one phone with no sideways scroll |
| | the UPI intent link | `upi://pay` carrying payee, ₹ amount, INR and a note naming the payer and the race |
| | a settled entry | every way to pay is withdrawn, so nobody pays twice |
| | an ordinary race | no virtual tag, no steps, still asks for an emergency contact and not an address |
| **Notices** | 89 checks at three layers | what each of the five emails says, called directly with no server or network |
| | transport | a fake SMTP server: addressed to the runner, `Reply-To` the organiser, marked auto-generated; a refused connection is returned, not raised |
| | the glue | each decision queues exactly one notice and only when something changed; paying twice, re-confirming and logging more runs after finishing all queue nothing |
| | with SMTP unset | every decision still saves, and an account with no email address is skipped silently |
| **Per-race admins** | 44 checks over the API | an unassigned race is open to every admin; naming one closes it; emptying the list reopens it |
| | **every race-level route, enumerated from the app** | all 34 answer `403` to an admin who is not on that race, including the six multipart ones. A route that is not scoped has to be named in the suite with a reason, so a new one added and forgotten fails here |
| | what cannot be assigned | a runner (`422`, told to be made an admin first), a super admin, an unknown id; none of them change the list |
| | the public side | results, the listing and the start list unchanged; entries still `401` to the public |
| **Per-race admins in the browser** | Chromium, 34 checks | the picker offers his race and not hers; the other race's address shows one message instead of a screen of refusals; Members, Workshops and Visitors are gone for an admin and Messages is not |
| **Deployment** | live site after each deploy | all pages `200`, results intact |

### One that got through

On 2026-09-28 a deploy took the live site down: every route `500`,
`FUNCTION_INVOCATION_FAILED`. Account seeding queries the users table, and the
migration adding `users.email` had been placed **after** it. On a fresh database
`create_all` builds the whole table, so every local test passed; on a database
that predates the column the seed query selects one that does not exist, the
import fails, and the application goes with it.

The rule that came out of it, and the test that now enforces it: **schema
migrations run before anything that reads the schema**, and a new column with
`nullable=False` is backfilled, because `ADD COLUMN` leaves existing rows
`NULL` while the response model says otherwise. Testing only against a fresh
database tests the one case production is never in.

### Two that got through

On 2026-10-05, building virtual races, two faults were caught by the suites
rather than by reading:

**The organiser's UPI handle was on a public response.** The payment settings
were added to `EventOut` with a comment calling it operator-only. It is the
response of `GET /api/events/{code}`, which is public. A schema shared between
an open route and an admin screen will leak sooner or later, so the settings
now have their own `VirtualSetupOut` on an operator-only route, and the suite
asserts the public response carries no payment field at all.

**A duplicate `const` took the whole admin screen down.** New code declared a
`toLocalInput` that already existed in the module. `node --check` passed it;
the browser refused the module outright, so race admin rendered nothing. The
lesson is not about that helper: a syntax check that passes is not a page that
loads, and only the browser suite knew the difference.

### Not verified

- Whether a **real UPI QR** scans from the screen. The suites upload and serve
  an image and check it renders; no phone has been pointed at it. Scan your own
  before announcing a race.
- **Nobody has run a virtual race end to end for real** — entering, paying,
  logging runs over weeks, and being posted a medal.
- The **printed** appearance of bibs and certificates on a real printer. Print
  one of each before committing to a run.
- Real QR scanning through a phone camera. Headless Chromium has no camera, so
  capture was exercised through manual bib entry, which takes the same path.
- Behaviour under concurrent load.

## 12. Deployment

| Platform | Fit | Notes |
|---|---|---|
| **Railway / Fly.io** | Best | Long-running process, persistent disk, no cold starts |
| **Vercel** | Workable | Serverless. `vercel.json` and `api/index.py` are included. **Postgres is mandatory** — the app refuses to boot on Vercel without `DATABASE_URL`. Expect cold starts of a second or two |

Required environment:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./racetime.db` | Postgres URL in production |
| `RACETIME_SEED_USERS` | *(unset)* | First-run accounts, `name:password:role,…`. Only consulted when the users table is empty |
| `ANALYTICS_SALT` | *(derived)* | Salt for the daily visitor hash. Set it to a random value in production |
| `CONTACT_EMAIL` | `sanjay.chhetri4u@gmail.com` | Where the contact form is emailed |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` | *(unset)* | Mail credentials. Unset means messages are kept but not forwarded |
| `SMTP_FROM` | `SMTP_USER` | The envelope sender, when it differs from the login |
| `RACETIME_NO_DEMO` | *(unset)* | Set to skip creating the practice event |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |

HTTPS is mandatory in any deployment: phone cameras will not start without it.

---

## 13. Running it

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
python seed.py                  # optional 40-runner demo race
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

Open <http://localhost:8000/>. Migrations run automatically at import, so an
existing database is upgraded in place.

Phone cameras require HTTPS or localhost. For on-phone testing use a tunnel
(`cloudflared tunnel --url http://localhost:8000`) or deploy.
