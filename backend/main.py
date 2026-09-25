"""RaceTime API.

Run it:  uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
Then open http://localhost:8000/
"""
import csv
import io
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import schemas
from .db import Base, SessionLocal, engine, get_db
from .models import Checkpoint, Event, Participant, Race, Read, utcnow
from .timing import compute_results

Base.metadata.create_all(bind=engine)


def _add_missing_columns(table: str, wanted: dict):
    """Add columns to a table that predates them.

    create_all() creates missing *tables* but never missing *columns*, so a
    racetime.db seeded before a feature existed would keep answering every
    query with "no such column". ADD COLUMN is understood by both SQLite and
    Postgres, so this covers either backend.
    """
    insp = inspect(engine)
    if not insp.has_table(table):
        return
    have = {c["name"] for c in insp.get_columns(table)}
    missing = {k: v for k, v in wanted.items() if k not in have}
    if not missing:
        return
    with engine.begin() as conn:
        for name, coltype in missing.items():
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {coltype}"))


def _backfill_default_race():
    """Give pre-existing events a race, so nothing is left unassigned.

    Everything before multi-race support had exactly one distance per event.
    That becomes one Race named after the finish checkpoint's distance, and
    every checkpoint and participant already in the event joins it. Idempotent:
    it only touches rows whose race_id is still NULL.
    """
    db = SessionLocal()
    try:
        orphan_events = {
            e for e in db.query(Event).all()
            if any(c.race_id is None for c in e.checkpoints)
            or any(p.race_id is None for p in e.participants)
        }
        for ev in orphan_events:
            race = ev.races[0] if ev.races else None
            if race is None:
                finish = next((c for c in ev.checkpoints if c.kind == "finish"), None)
                km = finish.distance_km if finish else 0.0
                # "10K" reads better than "Main race" and is what the organiser
                # would have typed anyway.
                label = f"{km:g}K" if km else "Main race"
                race = Race(event_id=ev.id, name=label, distance_km=km, sequence=0)
                db.add(race)
                db.flush()
            for c in ev.checkpoints:
                if c.race_id is None:
                    c.race_id = race.id
            for p in ev.participants:
                if p.race_id is None:
                    p.race_id = race.id
        if orphan_events:
            db.commit()
    finally:
        db.close()


def _import_disk_artwork():
    """Move any artwork still sitting in static/uploads into the database.

    Artwork used to be written to disk. That cannot work on a host with an
    ephemeral filesystem, so it now lives in a column. This carries the old
    files across once; it is a no-op on a fresh install and after the first run.
    """
    upload_dir = Path(__file__).resolve().parent.parent / "static" / "uploads"
    db = SessionLocal()
    try:
        stale = db.query(Event).filter(
            Event.artwork_url.isnot(None), Event.artwork_blob.is_(None)).all()
        moved = 0
        for ev in stale:
            if not ev.artwork_url.startswith("/uploads/"):
                continue
            src = upload_dir / Path(ev.artwork_url).name
            if not src.exists():
                # The file is gone, so the URL points at nothing. Clearing it
                # beats leaving a broken image on every bib.
                ev.artwork_url = None
                continue
            blob = src.read_bytes()
            try:
                ev.artwork_type = _sniff_image(blob)
            except HTTPException:
                ev.artwork_url = None
                continue
            ev.artwork_blob = blob
            ev.artwork_url = f"/api/events/{ev.code}/artwork?v={secrets.token_hex(4)}"
            moved += 1
        if stale:
            db.commit()
        if moved:
            print(f"Moved artwork for {moved} event(s) from disk into the database.")
    finally:
        db.close()


# SQLite and Postgres spell a binary column differently, and this is the only
# place the two disagree.
_BLOB = "BYTEA" if engine.dialect.name == "postgresql" else "BLOB"

_add_missing_columns("events", {
    "artwork_url": "VARCHAR(255)",
    "artwork_blob": _BLOB,
    "artwork_type": "VARCHAR(32)",
    "accent_color": "VARCHAR(16)",
    "tagline": "VARCHAR(160)",
    "bib_style": "VARCHAR(8)",
})
_add_missing_columns("checkpoints", {"race_id": "INTEGER"})
_add_missing_columns("participants", {"race_id": "INTEGER", "gender": "VARCHAR(16)"})
_backfill_default_race()

app = FastAPI(title="RaceTime", version="1.0")

# Capture phones are served from the same origin in the default setup, so CORS
# is only here for the case where you host the frontend separately.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("ALLOWED_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(IntegrityError)
async def _integrity_error(request, exc):
    """Answer a constraint violation instead of crashing.

    Uniqueness is enforced in the database as well as in the handlers, and the
    database wins races the handlers cannot see. Unhandled, SQLAlchemy's error
    became a 500 whose body was the plain text "Internal Server Error" -- which
    the frontend then tried to parse as JSON, so the operator saw
    "Unexpected token 'I'" instead of what was actually wrong.
    """
    detail = "That value is already taken."
    text_ = str(getattr(exc, "orig", exc)).lower()
    if "uq_checkpoint_name" in text_ or "checkpoints.name" in text_:
        detail = ("A checkpoint with that name already exists in this event. "
                  "Names are unique across the whole event, not per race, "
                  "because volunteers pick from one flat list -- so use "
                  "'5K Start' and '2K Start' rather than '0km' twice.")
    elif "uq_participant_bib" in text_ or "participants.bib" in text_:
        detail = "That bib number is already used by another runner in this event."
    elif "uq_race_name" in text_ or "races.name" in text_:
        detail = "This event already has a race with that name."
    elif "events.code" in text_:
        detail = "That event code is already taken."
    return JSONResponse(status_code=409, content={"detail": detail})


# --------------------------------------------------------------------------
# Admin authentication
# --------------------------------------------------------------------------

ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "").strip()

if not ADMIN_TOKEN:
    print(
        "\n  WARNING: ADMIN_TOKEN is not set, so every endpoint is open."
        "\n  Anyone who can reach this server can create, edit and"
        "\n  delete races. That is fine on a laptop. Set ADMIN_TOKEN"
        "\n  before putting this on the internet.\n",
        flush=True,
    )


def require_admin(x_admin_token: str = Header(default="")) -> None:
    """Guard the endpoints that change a race.

    Left open on purpose, because the two apps that need them cannot hold a
    secret: a volunteer's capture screen and the public results page are just
    static files served to anyone. So reading a single event, its start list,
    its results and its artwork stay public -- and so does POSTing reads.

    That last one is a conscious v1 tradeoff. Reads are append-only and every
    one of them can be voided, so the worst an anonymous poster can do is add
    noise a race director clears from the audit screen. It is not data loss,
    and it buys a capture app that works on any phone with no setup.
    """
    if not ADMIN_TOKEN:
        return
    # compare_digest keeps the check constant-time, so the token cannot be
    # guessed a character at a time by timing the responses.
    if not x_admin_token or not secrets.compare_digest(x_admin_token, ADMIN_TOKEN):
        raise HTTPException(401, "Admin token missing or incorrect")


ADMIN = [Depends(require_admin)]


@app.get("/api/admin/check")
def admin_check(_: None = Depends(require_admin)):
    """Lets the admin page tell a good token from a bad one before it saves it."""
    return {"ok": True, "protected": bool(ADMIN_TOKEN)}


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@app.middleware("http")
async def _revalidate_static(request, call_next):
    """Make browsers revalidate the app's own files on every load.

    StaticFiles sends an ETag and Last-Modified but no Cache-Control. With no
    explicit directive a browser falls back to heuristic caching and may serve
    a stale file without asking, which is how you end up running a cached
    index page against freshly deployed JavaScript: an element the new script
    expects is missing, the module throws on load, and the page renders
    nothing at all.

    "no-cache" does not mean "do not store" -- it means "always revalidate",
    so the ETag still turns an unchanged file into a cheap 304.

    Uploaded artwork is exempt: its URL already carries a content hash, so it
    keeps the immutable caching set where it is served.
    """
    response = await call_next(request)
    path = request.url.path
    if path.startswith("/api/"):
        return response
    if not response.headers.get("cache-control"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# --------------------------------------------------------------------------
# Clock
# --------------------------------------------------------------------------

@app.get("/api/time", response_model=schemas.TimeOut)
def server_time():
    """Reference clock.

    Capture devices call this at checkpoint setup, measure the round trip, and
    store the difference between their own clock and this one. Every scan is
    then corrected by that offset before it is sent. Without this step, a
    volunteer phone that is eight seconds fast silently adds eight seconds to
    every split it records, and nothing downstream can detect it.
    """
    now = datetime.now(timezone.utc)
    return {"server_time": now, "epoch_ms": int(now.timestamp() * 1000)}


# --------------------------------------------------------------------------
# Events
# --------------------------------------------------------------------------

def _get_event(db: Session, code: str) -> Event:
    ev = db.query(Event).filter(Event.code == code).first()
    if not ev:
        raise HTTPException(404, f"No event with code '{code}'")
    return ev


@app.get("/api/events/public")
def list_events_public(db: Session = Depends(get_db)):
    """Just enough to fill a dropdown: which races exist, and what they're called.

    The full listing is admin-only, but the certificate finder and the
    checkpoint setup screen are public pages that still have to offer a choice
    of race. This exposes only the code and name -- no branding, no gun time,
    no checkpoints -- and the code is already public, since it is in every link
    handed to a runner.
    """
    return [
        {"code": e.code, "name": e.name}
        for e in db.query(Event).order_by(Event.created_at.desc()).all()
    ]


@app.get("/api/events", response_model=List[schemas.EventOut], dependencies=ADMIN)
def list_events(db: Session = Depends(get_db)):
    return db.query(Event).order_by(Event.created_at.desc()).all()


@app.post("/api/events", response_model=schemas.EventOut, status_code=201, dependencies=ADMIN)
def create_event(payload: schemas.EventIn, db: Session = Depends(get_db)):
    if db.query(Event).filter(Event.code == payload.code).first():
        raise HTTPException(409, f"Event code '{payload.code}' is already taken")
    ev = Event(**payload.model_dump())
    db.add(ev)
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/api/events/{code}", response_model=schemas.EventOut)
def get_event(code: str, db: Session = Depends(get_db)):
    return _get_event(db, code)


@app.post("/api/events/{code}/start", response_model=schemas.EventOut, dependencies=ADMIN)
def set_start(code: str, at: datetime | None = None, db: Session = Depends(get_db)):
    """Fire the gun. Omit `at` to use the server clock right now."""
    ev = _get_event(db, code)
    ev.start_time = at or datetime.now(timezone.utc)
    db.commit()
    db.refresh(ev)
    return ev


# --------------------------------------------------------------------------
# Branding -- artwork for printed bibs and finisher certificates
# --------------------------------------------------------------------------

MAX_ARTWORK_BYTES = 5 * 1024 * 1024

# Raster only, and deliberately no SVG. Uploads are served from our own origin,
# and an SVG is a script-execution vector, so accepting one would hand anybody
# who can reach the admin page stored XSS on every page that shows the artwork.
ARTWORK_TYPES = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
}


def _sniff_image(blob: bytes) -> str:
    """Return the media type for `blob`, trusting its bytes rather than the
    client-supplied content type, which is just a header anyone can set."""
    for magic, mime in ARTWORK_TYPES.items():
        if blob.startswith(magic):
            return mime
    # WebP is RIFF....WEBP, so it needs a look past the 4-byte length field.
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    raise HTTPException(422, "Artwork must be a PNG, JPEG or WebP image")


_import_disk_artwork()


@app.post("/api/events/{code}/artwork", response_model=schemas.EventOut, dependencies=ADMIN)
async def upload_artwork(code: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Attach race artwork to an event.

    Stored in the database rather than on disk. A serverless host hands every
    request a fresh, empty filesystem, so a file written here would be gone by
    the next invocation -- and the uploaded filename is never used for anything,
    which also closes the usual path-traversal hole.
    """
    ev = _get_event(db, code)
    blob = await file.read()
    if not blob:
        raise HTTPException(422, "That file is empty")
    if len(blob) > MAX_ARTWORK_BYTES:
        raise HTTPException(
            413, f"Artwork must be under {MAX_ARTWORK_BYTES // (1024 * 1024)} MB")

    ev.artwork_type = _sniff_image(blob)
    ev.artwork_blob = blob
    # The random token is cache-busting: browsers and the print preview would
    # otherwise keep showing last week's logo at an unchanged URL.
    ev.artwork_url = f"/api/events/{ev.code}/artwork?v={secrets.token_hex(4)}"
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/api/events/{code}/artwork")
def get_artwork(code: str, db: Session = Depends(get_db)):
    """Serve the stored image. The URL carries a cache-busting token, so this
    can be cached hard -- a new upload produces a new URL."""
    ev = _get_event(db, code)
    if not ev.artwork_blob:
        raise HTTPException(404, "This event has no artwork")
    return Response(
        content=ev.artwork_blob,
        media_type=ev.artwork_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.delete("/api/events/{code}/artwork", response_model=schemas.EventOut, dependencies=ADMIN)
def clear_artwork(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    ev.artwork_url = None
    ev.artwork_blob = None
    ev.artwork_type = None
    db.commit()
    db.refresh(ev)
    return ev


@app.patch("/api/events/{code}/branding", response_model=schemas.EventOut, dependencies=ADMIN)
def set_branding(code: str, payload: schemas.BrandingIn, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    # exclude_unset so that PATCHing only the tagline does not wipe the colour.
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(ev, field, value or None)
    db.commit()
    db.refresh(ev)
    return ev


# --------------------------------------------------------------------------
# Races
# --------------------------------------------------------------------------

def _resolve_race_id(ev: Event, race_id: Optional[int]) -> Optional[int]:
    """Pick the race a checkpoint or participant belongs to.

    An event with one race does not make anyone choose -- that keeps every
    single-distance event, and the whole existing API, working untouched.
    Once there are two, the caller has to say which.
    """
    valid = {r.id for r in ev.races}
    if race_id is not None:
        if race_id not in valid:
            raise HTTPException(422, f"Race {race_id} does not belong to this event")
        return race_id
    if len(ev.races) == 1:
        return ev.races[0].id
    if not ev.races:
        return None
    raise HTTPException(
        422, "This event has several races, so race_id is required")


@app.get("/api/events/{code}/races", response_model=List[schemas.RaceOut])
def list_races(code: str, db: Session = Depends(get_db)):
    return _get_event(db, code).races


@app.post("/api/events/{code}/races", response_model=schemas.RaceOut, status_code=201, dependencies=ADMIN)
def add_race(code: str, payload: schemas.RaceIn, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    if any(r.name.lower() == payload.name.strip().lower() for r in ev.races):
        raise HTTPException(409, f"This event already has a race called '{payload.name}'")
    race = Race(event_id=ev.id, **payload.model_dump())
    race.name = race.name.strip()
    db.add(race)
    db.commit()
    db.refresh(race)
    return race


@app.patch("/api/races/{race_id}", response_model=schemas.RaceOut, dependencies=ADMIN)
def update_race(race_id: int, payload: schemas.RaceIn, db: Session = Depends(get_db)):
    race = db.get(Race, race_id)
    if not race:
        raise HTTPException(404, f"No race with id {race_id}")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(race, field, value)
    db.commit()
    db.refresh(race)
    return race


@app.delete("/api/races/{race_id}", status_code=204, dependencies=ADMIN)
def delete_race(race_id: int, db: Session = Depends(get_db)):
    race = db.get(Race, race_id)
    if not race:
        return
    if race.participants:
        raise HTTPException(
            409,
            f"{len(race.participants)} runners are still entered in this race. "
            "Move them to another race first.")
    db.delete(race)
    db.commit()


# --------------------------------------------------------------------------
# Checkpoints
# --------------------------------------------------------------------------

def _assert_sequence_free(db: Session, ev: Event, race_id, sequence: int,
                          exclude_id: int | None = None) -> None:
    """Refuse a sequence already taken by another checkpoint in the same race.

    Sequence decides the order of split columns in the results, so two
    checkpoints sharing one is ambiguous. It happens to sort correctly when
    distance breaks the tie, which is exactly what makes it a trap: it looks
    fine until a race where it does not.
    """
    clash = next(
        (c for c in ev.checkpoints
         if c.race_id == race_id and c.sequence == sequence and c.id != exclude_id),
        None)
    if clash:
        raise HTTPException(
            409,
            f"Sequence {sequence} is already used by '{clash.name}' in this race. "
            f"Give this checkpoint a different order number.")


@app.post("/api/events/{code}/checkpoints", response_model=schemas.CheckpointOut, status_code=201, dependencies=ADMIN)
def add_checkpoint(code: str, payload: schemas.CheckpointIn, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    if payload.kind not in ("start", "split", "finish"):
        raise HTTPException(422, "kind must be start, split or finish")
    fields = payload.model_dump()
    fields["race_id"] = _resolve_race_id(ev, fields.get("race_id"))
    _assert_sequence_free(db, ev, fields["race_id"], fields["sequence"])
    cp = Checkpoint(event_id=ev.id, **fields)
    db.add(cp)
    db.commit()
    db.refresh(cp)
    return cp


@app.patch("/api/checkpoints/{cp_id}", response_model=schemas.CheckpointOut, dependencies=ADMIN)
def update_checkpoint(cp_id: int, payload: schemas.CheckpointUpdate,
                      db: Session = Depends(get_db)):
    cp = db.get(Checkpoint, cp_id)
    if not cp:
        raise HTTPException(404, f"No checkpoint with id {cp_id}")
    ev = db.get(Event, cp.event_id)
    fields = payload.model_dump(exclude_unset=True)

    # Validate against where the checkpoint will end up, which may be a
    # different race than the one it is in now.
    race_id = fields.get("race_id", cp.race_id)
    if "race_id" in fields:
        race_id = _resolve_race_id(ev, fields["race_id"])
        fields["race_id"] = race_id
    sequence = fields.get("sequence", cp.sequence)
    if "sequence" in fields or "race_id" in fields:
        _assert_sequence_free(db, ev, race_id, sequence, exclude_id=cp.id)

    for field, value in fields.items():
        setattr(cp, field, value)
    db.commit()
    db.refresh(cp)
    return cp


@app.get("/api/events/{code}/checkpoints", response_model=List[schemas.CheckpointOut])
def list_checkpoints(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    return ev.checkpoints


@app.delete("/api/checkpoints/{cp_id}", status_code=204, dependencies=ADMIN)
def delete_checkpoint(cp_id: int, db: Session = Depends(get_db)):
    cp = db.get(Checkpoint, cp_id)
    if cp:
        db.delete(cp)
        db.commit()


# --------------------------------------------------------------------------
# Participants
# --------------------------------------------------------------------------

@app.get("/api/events/{code}/participants", response_model=List[schemas.ParticipantOut])
def list_participants(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    return sorted(ev.participants, key=lambda p: p.bib.zfill(8))


@app.post("/api/events/{code}/participants", response_model=List[schemas.ParticipantOut], dependencies=ADMIN)
def add_participants(code: str, payload: List[schemas.ParticipantIn], db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    existing = {p.bib for p in ev.participants}
    added = []
    for row in payload:
        if row.bib in existing:
            continue
        fields = row.model_dump()
        fields["race_id"] = _resolve_race_id(ev, fields.get("race_id"))
        p = Participant(event_id=ev.id, **fields)
        db.add(p)
        added.append(p)
        existing.add(row.bib)
    db.commit()
    for p in added:
        db.refresh(p)
    return added


@app.post("/api/events/{code}/participants/csv", response_model=List[schemas.ParticipantOut], dependencies=ADMIN)
async def import_participants_csv(code: str, file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Import a start list.

    Columns: bib, name, category, gender, race. Only `bib` is required; a
    `race` value is matched against the event's race names so one file can
    cover every distance.
    """
    ev = _get_event(db, code)
    raw = (await file.read()).decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(raw))
    if not reader.fieldnames or "bib" not in [f.strip().lower() for f in reader.fieldnames]:
        raise HTTPException(422, "CSV needs a header row with at least 'bib' and 'name'")

    # A "race" column lets one start-list file cover a multi-distance event,
    # matched on the race name so organisers never have to look up an id.
    by_name = {r.name.strip().lower(): r.id for r in ev.races}

    rows = []
    for r in reader:
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in r.items()}
        if not r.get("bib"):
            continue
        race_id = None
        if r.get("race"):
            race_id = by_name.get(r["race"].lower())
            if race_id is None:
                raise HTTPException(
                    422,
                    f"Row for bib {r['bib']} names race '{r['race']}', which "
                    f"does not exist in this event. Create it first.")
        rows.append(schemas.ParticipantIn(
            bib=r["bib"], name=r.get("name") or f"Bib {r['bib']}",
            category=r.get("category") or None,
            gender=r.get("gender") or None,
            race_id=race_id,
        ))
    return add_participants(code, rows, db)


@app.delete("/api/participants/{pid}", status_code=204, dependencies=ADMIN)
def delete_participant(pid: int, db: Session = Depends(get_db)):
    """Remove a runner from the start list.

    Any reads already taken for that bib stay where they are -- reads are
    append-only and keyed by bib, not by participant. They simply show up in
    the audit log as belonging to an unregistered bib, which is exactly what
    happened, and re-adding the bib picks them up again.
    """
    p = db.get(Participant, pid)
    if p:
        db.delete(p)
        db.commit()


@app.patch("/api/participants/{pid}", response_model=schemas.ParticipantOut, dependencies=ADMIN)
def update_participant(pid: int, payload: schemas.ParticipantIn, db: Session = Depends(get_db)):
    """Correct a runner's details. Changing a bib invalidates their printed
    QR code, so the caller is trusted to reprint."""
    p = db.get(Participant, pid)
    if not p:
        raise HTTPException(404, f"No runner with id {pid}")
    fields = payload.model_dump(exclude_unset=True)
    new_bib = fields.get("bib", p.bib)
    if new_bib != p.bib:
        clash = db.query(Participant).filter(
            Participant.event_id == p.event_id,
            Participant.bib == new_bib,
            Participant.id != pid).first()
        if clash:
            raise HTTPException(409, f"Bib {new_bib} is already taken by {clash.name}")
    for field, value in fields.items():
        setattr(p, field, value)
    db.commit()
    db.refresh(p)
    return p


@app.post("/api/events/{code}/participants/{bib}/dnf", response_model=schemas.ParticipantOut, dependencies=ADMIN)
def mark_dnf(code: str, bib: str, dnf: bool = True, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    p = db.query(Participant).filter(
        Participant.event_id == ev.id, Participant.bib == bib).first()
    if not p:
        raise HTTPException(404, f"Bib {bib} is not registered for this event")
    p.dnf = dnf
    db.commit()
    db.refresh(p)
    return p


# --------------------------------------------------------------------------
# Reads -- the hot path
# --------------------------------------------------------------------------

@app.post("/api/events/{code}/reads", response_model=schemas.ReadBatchOut)
def ingest_reads(code: str, payload: schemas.ReadBatchIn, db: Session = Depends(get_db)):
    """Accept a batch of sightings from any capture source.

    Deliberately shaped so that a QR scan from a phone, a manual bib entry by a
    volunteer, and a tag read from an RFID mat all post the identical payload.
    That is the whole upgrade path: when you rent timing mats, you write a small
    bridge that speaks to the reader and posts here. No part of this service
    changes.

    Safe to call repeatedly with the same batch. Duplicate read_ids are counted
    and dropped, so a phone that loses connectivity mid-upload can simply resend
    everything in its queue.
    """
    ev = _get_event(db, code)
    valid_cps = {c.id for c in ev.checkpoints}
    known_bibs = {p.bib for p in ev.participants}

    incoming_ids = [r.read_id for r in payload.reads]
    already = set()
    if incoming_ids:
        for chunk_start in range(0, len(incoming_ids), 500):
            chunk = incoming_ids[chunk_start:chunk_start + 500]
            already.update(
                row[0] for row in
                db.query(Read.read_id).filter(Read.read_id.in_(chunk)).all()
            )

    accepted = duplicates = 0
    rejected = []
    seen_in_batch = set()

    for r in payload.reads:
        if r.read_id in already or r.read_id in seen_in_batch:
            duplicates += 1
            continue
        if r.checkpoint_id not in valid_cps:
            rejected.append({"read_id": r.read_id, "reason": "unknown checkpoint"})
            continue
        # An unknown bib is still stored. A runner who lost their bib, or a
        # typo, is a reconciliation problem for the race director afterwards --
        # it is never a reason to throw away evidence at the finish line.
        if r.bib not in known_bibs:
            rejected.append({"read_id": r.read_id, "reason": "bib not registered (stored anyway)"})
        db.add(Read(
            read_id=r.read_id,
            event_id=ev.id,
            checkpoint_id=r.checkpoint_id,
            bib=r.bib,
            observed_at=r.observed_at,
            device_time=r.device_time,
            clock_offset_ms=r.clock_offset_ms,
            source=r.source,
            device_id=r.device_id,
            server_received_at=utcnow(),
        ))
        seen_in_batch.add(r.read_id)
        accepted += 1

    db.commit()
    return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}


@app.get("/api/events/{code}/reads", dependencies=ADMIN)
def list_reads(code: str, limit: int = 500, db: Session = Depends(get_db)):
    """Raw audit log, newest first."""
    ev = _get_event(db, code)
    rows = (db.query(Read).filter(Read.event_id == ev.id)
            .order_by(Read.server_received_at.desc()).limit(limit).all())
    names = {c.id: c.name for c in ev.checkpoints}
    # No response_model here, so timestamps are normalised by hand.
    return [{
        "read_id": r.read_id, "bib": r.bib,
        "checkpoint": names.get(r.checkpoint_id, "?"),
        "observed_at": schemas.as_utc(r.observed_at), "source": r.source,
        "device_time": schemas.as_utc(r.device_time),
        "server_received_at": schemas.as_utc(r.server_received_at),
        "device_id": r.device_id, "clock_offset_ms": r.clock_offset_ms,
        "voided": r.voided,
    } for r in rows]


@app.post("/api/reads/{read_id}/void", dependencies=ADMIN)
def void_read(read_id: str, voided: bool = True, db: Session = Depends(get_db)):
    """Exclude a read from timing without deleting it.

    Use this for the scan a volunteer took of their own bib to test the camera.
    The row stays in the table; it just stops counting.
    """
    r = db.get(Read, read_id)
    if not r:
        raise HTTPException(404, "No such read")
    r.voided = voided
    db.commit()
    return {"read_id": read_id, "voided": voided}


# --------------------------------------------------------------------------
# Results
# --------------------------------------------------------------------------

@app.get("/api/events/{code}/results")
def results(code: str, db: Session = Depends(get_db)):
    """Results for every race in the event, ranked within each race.

    Each race is timed and placed independently, so a 5K runner is never
    ranked against the 10K field, and each race can have had its own gun.
    """
    ev = _get_event(db, code)
    reads = db.query(Read).filter(Read.event_id == ev.id).all()

    rows = []
    for race in ev.races:
        rows.extend(compute_results(
            ev, race.checkpoints, race.participants, reads, race=race))

    # Anyone still unassigned -- possible only if a race was deleted out from
    # under them -- is timed against the event's own checkpoints so they never
    # silently vanish from the results.
    loose = [p for p in ev.participants if p.race_id is None]
    if loose:
        rows.extend(compute_results(
            ev, [c for c in ev.checkpoints if c.race_id is None], loose, reads))

    return {
        # Same here: hand-built dicts, so as_utc is applied at each timestamp.
        "event": {"code": ev.code, "name": ev.name,
                  "start_time": schemas.as_utc(ev.start_time)},
        "races": [
            {"id": r.id, "name": r.name, "distance_km": r.distance_km,
             "start_time": schemas.as_utc(r.start_time), "sequence": r.sequence}
            for r in ev.races
        ],
        "checkpoints": [
            {"id": c.id, "name": c.name, "distance_km": c.distance_km,
             "kind": c.kind, "race_id": c.race_id}
            for c in ev.checkpoints
        ],
        "results": rows,
    }


@app.get("/api/health")
def health():
    return {"ok": True, "time": datetime.now(timezone.utc)}


# --------------------------------------------------------------------------
# Static frontends
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
