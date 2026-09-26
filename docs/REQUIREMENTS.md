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
| **Organiser** | `/admin.html` | Laptop | Has network; sets the race up in advance |
| **Volunteer** | `/checkpoint.html` | Phone | Often no signal; outdoors; one-handed |
| **Runner / public** | `/results.html`, `/certificate.html` | Phone or laptop | Any time during or after the race |

---

## 3. Data model

Five tables. `reads` is the source of truth; everything a runner sees is derived
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

### 3.5 Read — append-only

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
  screens work whether or not `ADMIN_TOKEN` is set.

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
  reached a terminal state** (finished or DNF) -- not merely when nobody is on
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

### FR-7a — Race admin layout (`/admin.html#<code>[/<section>]`)

- **FR-7a.1** The event's sections are **tabs**: Runners, Races, Checkpoints,
  Artwork, Reads. One panel renders at a time. As one page it ran to 16,000px,
  with Runners -- the screen used on the morning -- below three sections that are
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
- **FR-7a.7** Destructive actions in a table row are **quiet** -- text weight,
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

### FR-10 — Admin authentication

- **FR-10.1** The admin token is read from the `ADMIN_TOKEN` environment
  variable at startup.
- **FR-10.2** When `ADMIN_TOKEN` is **unset**, every endpoint stays open and a
  warning is printed at startup. Local development is unaffected.
- **FR-10.3** When it is set, 19 endpoints require that value in an
  `X-Admin-Token` header and answer `401` without it: list all events, create
  event, set start, artwork upload and delete, branding, race create / update /
  delete, checkpoint create / update / delete, participant add / CSV import /
  update / delete, mark DNF, the raw reads listing, and void read.
- **FR-10.4** The token is compared with `secrets.compare_digest`, so it cannot
  be recovered a character at a time by timing responses.
- **FR-10.5** These stay **public by design**: a single event by code, its
  races, its checkpoints, its participants, its results, its artwork,
  `/api/time`, `/api/health`, and **`POST` reads**. See
  [§8.1](#81-why-read-ingest-is-open).
- **FR-10.6** `GET /api/admin/check` reports whether the server is protected and
  validates a candidate token, so the admin page can tell a good token from a
  bad one before storing it.
- **FR-10.7** Race admin shows a `locked` / `unlocked` control in the masthead,
  and hides it entirely when the server is unprotected. The token is kept in
  `localStorage`.
- **FR-10.8** On a `401` the stored token is cleared, the operator is asked
  again, and **the original request is replayed** so work in progress is not
  lost.

### FR-11 — Audit

- **FR-11.1** Every read is visible newest-first with bib, checkpoint, time,
  source and clock drift. Drift over 2 seconds is flagged. The listing requires
  the admin token.
- **FR-11.2** A read may be **voided**, excluding it from timing while keeping
  the row. There is no delete.


---

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

29 routes. **19 require the admin token** when `ADMIN_TOKEN` is set; they are
marked 🔒 and answer `401` without an `X-Admin-Token` header. Interactive docs
at `/docs` while the server runs.

### Clock and health
| | Method | Path | Purpose |
|---|---|---|---|
| | `GET` | `/api/time` | Reference clock for capture devices |
| | `GET` | `/api/health` | Liveness |
| | `GET` | `/api/admin/check` | Is this server protected, and is this token valid |

### Events
| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | `GET` | `/api/events` | List every event |
| | `GET` | `/api/events/public` | Code and name only, for the race pickers |
| 🔒 | `POST` | `/api/events` | Create (`409` on duplicate code) |
| | `GET` | `/api/events/{code}` | One event, with races and checkpoints |
| 🔒 | `POST` | `/api/events/{code}/start` | Fire the gun; optional `?at=` |

### Branding
| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | `POST` | `/api/events/{code}/artwork` | Upload artwork (multipart) |
| 🔒 | `DELETE` | `/api/events/{code}/artwork` | Remove artwork |
| | `GET` | `/api/events/{code}/artwork` | Serve the stored image |
| 🔒 | `PATCH` | `/api/events/{code}/branding` | Accent colour, tagline, bib layout |

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

### Reads and results
| | Method | Path | Purpose |
|---|---|---|---|
| | `POST` | `/api/events/{code}/reads` | Batch ingest, idempotent — **public**, see [§8.1](#81-why-read-ingest-is-open) |
| 🔒 | `GET` | `/api/events/{code}/reads` | Raw audit log |
| 🔒 | `POST` | `/api/reads/{read_id}/void` | Exclude from timing, keep the row |
| | `GET` | `/api/events/{code}/results` | Races, checkpoints and ranked results |

## 7. Screens

| Screen | Path | Audience | Needs the token |
|---|---|---|---|
| Home | `/` | Everyone | no |
| Starter guide | `/guide.html` | Anyone new to the app | no |
| Race admin | `/admin.html#<code>` | Organiser | **yes**, to change anything |
| Checkpoint capture | `/checkpoint.html` | Volunteer | no |
| Live results | `/results.html#<code>` | Public | no |
| Finisher card | `/certificate.html#<code>/<bib>` | Runner | no |

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

### 8.1a Token handling

`ADMIN_TOKEN` is compared with `secrets.compare_digest`, so it cannot be
recovered a character at a time by timing responses. The admin page keeps it in
`localStorage` and validates it against `/api/admin/check` before storing, so a
typo is caught at entry. **Leaving `ADMIN_TOKEN` unset leaves the whole API
open** — deliberate, so a laptop needs no setup, and announced with a startup
warning.

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

### 9.7 One shared admin token, not accounts
There are no named logins, no roles and no audit of who changed what. Everyone
who administers a race shares one secret, and rotating it signs everybody out.
That is proportionate for a one- or two-person timing crew and would not be for
a larger organisation.

---

## 10. Not built

| Area | Status |
|---|---|
| User accounts / per-user roles | Not built. There is one shared admin token, not named logins |
| Online registration | Not built. Start lists are imported by the organiser |
| Payments | Not built |
| Year grouping of events | Not built. Only useful across multiple seasons |
| Race photography | Not built |
| SMS / email notification | Not built |
| Age-group awards | Partially covered by category ranking |

None of these require a data-model change; all are additive.

---

## 11. Verification performed

Everything below was run against a real browser or a live server, not reasoned
about. Anything not listed here is unverified.

| Area | Method | Result |
|---|---|---|
| **Admin gate** | 19 protected routes called with no token | all `401` |
| | same routes called with the token | none `401` |
| | 7 public routes called with no token | none `401` |
| | a wrong token | `401` |
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
| **Migrations** | applied to the existing seeded database | no data loss |
| **Deployment** | live site after each deploy | all pages `200`, results intact |

### Not verified

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
| `ADMIN_TOKEN` | *(unset)* | **Set this before any public deployment.** Unset means every endpoint is open |
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
