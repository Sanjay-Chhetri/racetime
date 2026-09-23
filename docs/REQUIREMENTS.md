# RaceTime — Requirements and Functional Specification

**Version:** 1.1 · **Last updated:** 6 September 2026

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
leaderboard, printable branded bibs, and finisher certificates.

**Out of scope today:** authentication, online registration, payments,
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
| `artwork_url` | string(255), nullable | Web path of the uploaded artwork |
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

### FR-4 — Participants (start list)

- **FR-4.1** Add runners as a JSON list, or paste lines as
  `bib, name, category, gender`.
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
- **FR-7.3** Filter chips with live counts for **race**, **status** and
  **category**. Race chips appear only when the event has more than one race;
  category chips only when more than one category exists. Status chips appear
  only for statuses that actually occur.
- **FR-7.4** Selecting a race rescopes the category chips and counts to that
  race, and resets the category filter.
- **FR-7.5** Sort by rank, bib, name or finish time, ascending or descending.
  **Runners with no finish time always sort last, in both directions.**
- **FR-7.6** The top three in each race are colour-coded.
- **FR-7.7** Tapping a runner reveals their placings (*"1st of 19 in Open"*),
  every split with distance, elapsed and pace, a link to their certificate, and a
  Share button.
- **FR-7.8** Share uses the device's native share sheet where available and
  falls back to copying to the clipboard.

### FR-8 — Race artwork and printable bibs

- **FR-8.1** Upload artwork per event. **PNG, JPEG or WebP only, 5 MB maximum.**
- **FR-8.2** The file type is determined by **inspecting magic bytes**, not the
  declared `Content-Type`. SVG is refused — see [§8.2](#82-no-svg-uploads).
- **FR-8.3** The stored filename is generated server-side and never derived from
  the uploaded name, closing a path-traversal hole. A random suffix doubles as
  cache-busting.
- **FR-8.4** Replacing artwork deletes the previous file; a failure to delete is
  swallowed, since a stray file is harmless but a failed request is not.
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

### FR-9 — Finisher certificate (`/certificate.html`)

- **FR-9.1** A race is chosen from a dropdown of all events. A single event
  selects itself rather than presenting a list of one.
- **FR-9.2** One search box matches **name or bib**, filtering live, with the
  match highlighted. Name is the primary route: a runner returning weeks later
  has thrown the bib away.
- **FR-9.3** Non-finishers remain listed but disabled, labelled with the reason
  (`did not finish`, `still running`, `no sightings`), so searching your own name
  never returns an unexplained blank.
- **FR-9.4** The list caps at 40 rows with a prompt to narrow the search.
- **FR-9.5** The certificate shows the event artwork full-bleed under a scrim,
  the runner's name, finish time, overall placing, **category and gender placings
  with field sizes**, race distance, average pace, every split, and a QR linking
  back to the public results for verification.
- **FR-9.6** All distance and pace figures come from **the runner's own race**.
- **FR-9.7** Prints as a single A4 portrait page; "Save as PDF" gives a
  framing-quality copy.
- **FR-9.8** Deep links work: `/certificate.html#<code>/<bib>` opens a
  certificate directly, which is what the results table links to.

### FR-10 — Audit

- **FR-10.1** Every read is visible newest-first with bib, checkpoint, time,
  source and clock drift. Drift over 2 seconds is flagged.
- **FR-10.2** A read may be **voided**, excluding it from timing while keeping
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
| **NFR-8** | SQLite by default with zero setup; `DATABASE_URL` switches to Postgres with no code change. |
| **NFR-9** | Schema migrations run automatically at import and are idempotent. |

---

## 6. API reference

24 routes. Interactive docs at `/docs` while the server runs.

### Clock
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/time` | Reference clock for capture devices |
| `GET` | `/api/health` | Liveness |

### Events
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/events` | List, newest first |
| `POST` | `/api/events` | Create (`409` on duplicate code) |
| `GET` | `/api/events/{code}` | One event, with races and checkpoints |
| `POST` | `/api/events/{code}/start` | Fire the gun; optional `?at=` |

### Branding
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/events/{code}/artwork` | Upload artwork (multipart) |
| `DELETE` | `/api/events/{code}/artwork` | Remove artwork |
| `PATCH` | `/api/events/{code}/branding` | Accent colour, tagline, bib layout |

### Races
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/events/{code}/races` | List |
| `POST` | `/api/events/{code}/races` | Create (`409` on duplicate name) |
| `PATCH` | `/api/races/{race_id}` | Update |
| `DELETE` | `/api/races/{race_id}` | Delete (`409` if runners entered) |

### Checkpoints
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/events/{code}/checkpoints` | List |
| `POST` | `/api/events/{code}/checkpoints` | Create |
| `DELETE` | `/api/checkpoints/{cp_id}` | Delete |

### Participants
| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/events/{code}/participants` | Start list |
| `POST` | `/api/events/{code}/participants` | Add a JSON list |
| `POST` | `/api/events/{code}/participants/csv` | Import CSV |
| `POST` | `/api/events/{code}/participants/{bib}/dnf` | Mark DNF |

### Reads and results
| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/events/{code}/reads` | Batch ingest, idempotent |
| `GET` | `/api/events/{code}/reads` | Raw audit log |
| `POST` | `/api/reads/{read_id}/void` | Exclude from timing, keep the row |
| `GET` | `/api/events/{code}/results` | Races, checkpoints and ranked results |

---

## 7. Screens

| Screen | Path | Audience |
|---|---|---|
| Home | `/` | Everyone |
| Race admin | `/admin.html#<code>` | Organiser |
| Checkpoint capture | `/checkpoint.html` | Volunteer |
| Live results | `/results.html#<code>` | Public |
| Finisher certificate | `/certificate.html#<code>/<bib>` | Runner |

---

## 8. Security posture

### 8.1 No authentication
**Every endpoint is unauthenticated.** Anyone who can reach the server can create
events, alter start lists and void reads. This is acceptable only on a trusted
LAN. Put authentication in front of `/admin.html` and the write endpoints before
exposing this to the internet.

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
Keep the start list consistent.

### 9.5 Artwork is cropped differently in each place
One image feeds a 180 × 132 mm bib and an A4 portrait certificate, both
`cover`-cropped from the centre. Compose with the focal point centred and nothing
important near the edges or along the bottom, where the scrim is heaviest.
Recommended source: **3000 × 2000 px (3:2)**, JPEG for photographs.

### 9.6 Visual output is unverified by automated test
Logic, API behaviour and data are covered by the checks in §11. The *appearance*
of printed bibs and certificates has not been verified in a browser. **Print one
bib and one certificate before committing to a print run.**

---

## 10. Not built

| Area | Status |
|---|---|
| Authentication / authorisation | Not built. Required before public deployment |
| Online registration | Not built. Start lists are imported by the organiser |
| Payments | Not built |
| Year grouping of events | Not built. Only useful across multiple seasons |
| Race photography | Not built |
| SMS / email notification | Not built |
| Age-group awards | Partially covered by category ranking |

None of these require a data-model change; all are additive.

---

## 11. Verification performed

| Area | Method | Result |
|---|---|---|
| Branding endpoints | Live API: upload, serve, partial PATCH, replace, cleanup | Pass |
| Upload rejection | SVG content named `.png`, declared `image/png` | Rejected `422` |
| `bib_style` validation | Bogus value posted | Rejected `422` |
| Migrations | Applied to the existing seeded database | Columns and `races` table added; no data loss |
| Multi-race ranking | Purpose-built 5K + 10K event, 8 runners | 6/6 checks pass |
| — one winner per race | | Pass |
| — 5K winner not ranked against 10K field | | Pass |
| — category ranks and sizes scoped to race | | Pass |
| — staggered start honoured (22:00, not 52:00) | | Pass |
| — race deletion blocked with runners entered | | Rejected `409` |
| Certificate data assembly | Replayed against live API | Pace, ordinals, splits correct |
| Ordinal suffixes | `11th/12th/13th` and `21st/22nd/23rd` | Pass |
| Leaderboard sort | Unfinished runners in both directions | Always sort last |
| Search and escaping | `<img src=x onerror=...>` as a runner name | Rendered inert |
| QR generation | `toCanvas` driven with a stub canvas | 108 × 108, dark modules present |
| JavaScript modules | `node --check` on all five | Pass |

---

## 12. Running it

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
