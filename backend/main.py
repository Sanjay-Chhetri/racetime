"""RaceTime API.

Run it:  uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
Then open http://localhost:8000/
"""
import csv
import io
import os
import re
import secrets
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import (
    Depends, FastAPI, Form, HTTPException, Request, UploadFile, File,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse, JSONResponse, RedirectResponse, Response,
)
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import achievements, analytics, auth, mail, models, schemas
from .db import Base, SessionLocal, engine, get_db
from .models import Checkpoint, Event, Participant, Race, Read, utcnow
from .timing import compute_results, event_result_rows

Base.metadata.create_all(bind=engine)


# SQLite and Postgres spell a binary column differently. Defined here because
# the photo migration below needs it, and migrations must run before anything
# that reads the schema -- which is the rule an outage taught.
_BLOB_LATE = "BYTEA" if engine.dialect.name == "postgresql" else "BLOB"


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
    "cert_artwork_url": "VARCHAR(255)",
    "cert_artwork_blob": _BLOB,
    "cert_artwork_type": "VARCHAR(32)",
    "badge_mode": "VARCHAR(8)",
    "badge_text": "VARCHAR(40)",
    "cert_fit": "VARCHAR(8)",
    "artwork_url": "VARCHAR(255)",
    "artwork_blob": _BLOB,
    "artwork_type": "VARCHAR(32)",
    "accent_color": "VARCHAR(16)",
    "tagline": "VARCHAR(160)",
    "bib_style": "VARCHAR(8)",
})
_add_missing_columns("events", {
    "starts_at": "TIMESTAMP",
    "location": "VARCHAR(160)",
    "description": "VARCHAR(2000)",
    "is_published": "BOOLEAN",
    "registration_open": "BOOLEAN",
    "entry_note": "VARCHAR(400)",
})
_add_missing_columns("participants", {"user_id": "INTEGER"})
_add_missing_columns("events", {
    "photo_url": "VARCHAR(255)",
    "photo_blob": _BLOB_LATE,
    "photo_type": "VARCHAR(32)",
    "photo_credit": "VARCHAR(120)",
})
_add_missing_columns("users", {
    "email": "VARCHAR(190)",
    "phone": "VARCHAR(32)",
    "home_town": "VARCHAR(80)",
    "visibility": "VARCHAR(10)",
    "bio": "VARCHAR(600)",
    "running_since": "INTEGER",
    "preferred_distances": "VARCHAR(120)",
    "strava_url": "VARCHAR(200)",
    "birth_year": "INTEGER",
    "avatar_blob": _BLOB_LATE,
    "avatar_type": "VARCHAR(32)",
    "avatar_url": "VARCHAR(255)",
    "slug": "VARCHAR(48)",
    "consented_at": "TIMESTAMP",
    "announcements_opt_in": "BOOLEAN",
    "last_seen_at": "TIMESTAMP",
})
_add_missing_columns("events", {
    "is_virtual": "BOOLEAN",
    "ends_at": "TIMESTAMP",
    "upi_id": "VARCHAR(120)",
    "upi_name": "VARCHAR(120)",
    "payment_note": "VARCHAR(400)",
    "payment_qr_url": "VARCHAR(255)",
    "payment_qr_blob": _BLOB,
    "payment_qr_type": "VARCHAR(32)",
})
_add_missing_columns("races", {"price_paise": "INTEGER"})
_add_missing_columns("registrations", {
    "payment_status": "VARCHAR(10)",
    "amount_paise": "INTEGER",
    "payment_ref": "VARCHAR(60)",
    "paid_at": "TIMESTAMP",
    "ship_address": "VARCHAR(400)",
    "ship_phone": "VARCHAR(32)",
})


def _backfill_flags():
    """Give the new boolean columns a value on rows that predate them.

    ADD COLUMN leaves existing rows NULL, and the response model declares these
    as `bool`, so every event created before this feature would fail validation
    on the way out. Cheap, and idempotent.
    """
    for table, column in (("events", "is_published"),
                          ("events", "registration_open"),
                          ("events", "is_virtual"),
                          ("users", "announcements_opt_in")):
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    f"UPDATE {table} SET {column} = FALSE WHERE {column} IS NULL"))
        except Exception as e:                  # noqa: BLE001
            print(f"  Could not backfill {table}.{column}: {type(e).__name__}: {e}")


def _backfill_profiles():
    """Existing accounts predate the profile, so give them a safe default.

    Visibility must land on `private`, not NULL. A NULL here would be read as
    "not public" by the model and as nothing by the form, and the first person
    to save their profile would be publishing a setting they never chose.
    """
    try:
        with engine.begin() as conn:
            conn.execute(text(
                "UPDATE users SET visibility = 'private' WHERE visibility IS NULL"))
    except Exception as e:                      # noqa: BLE001
        print(f"  Could not backfill user visibility: {type(e).__name__}: {e}")


def _backfill_money():
    """Zero is not NULL, and the response models say int, not Optional[int].

    Same trap as the booleans: ADD COLUMN leaves old rows NULL, and a NULL
    price would come back out of a race that is simply free.
    """
    for table, column, value in (("races", "price_paise", "0"),
                                 ("registrations", "amount_paise", "0"),
                                 ("registrations", "payment_status", "'unpaid'")):
        try:
            with engine.begin() as conn:
                conn.execute(text(f"UPDATE {table} SET {column} = {value} "
                                  f"WHERE {column} IS NULL"))
        except Exception as e:                  # noqa: BLE001
            print(f"  Could not backfill {table}.{column}: {type(e).__name__}: {e}")


_backfill_flags()
_backfill_profiles()
_backfill_money()


def _seed_demo_event():
    """A published race with entries open, so the site is not empty on day one.

    Created once, only if it does not already exist, and never touched again --
    so an organiser can rename it, edit it or delete it without it coming back
    on the next deploy. RACETIME_NO_DEMO=1 skips it.
    """
    if os.getenv("RACETIME_NO_DEMO", "").strip():
        return
    db = SessionLocal()
    try:
        code = "demo"
        if db.query(Event).filter(Event.code == code).first():
            return
        ev = Event(
            code=code,
            name="Pedong Test Run",
            # Three weeks out, at a plausible hill-race hour rather than
            # whatever minute the server happened to boot.
            starts_at=(utcnow() + timedelta(days=21)).replace(
                hour=1, minute=30, second=0, microsecond=0),   # 07:00 IST
            location="Pedong, Kalimpong",
            description=(
                "A test race for trying RaceTime out end to end -- entering, "
                "bibs, scanning at the checkpoint, live results and a finisher "
                "certificate. Enter it, and nothing bad happens."
            ),
            entry_note="A practice event. Enter and withdraw as much as you like.",
            is_published=True,
            registration_open=True,
            tagline="A practice race",
        )
        db.add(ev)
        db.flush()

        short = Race(event_id=ev.id, name="2K", distance_km=2, sequence=1)
        long_ = Race(event_id=ev.id, name="5K", distance_km=5, sequence=2)
        db.add_all([short, long_])
        db.flush()

        db.add_all([
            Checkpoint(event_id=ev.id, race_id=short.id, name="2K Finish",
                       distance_km=2, sequence=1, kind="finish"),
            Checkpoint(event_id=ev.id, race_id=long_.id, name="5K Turn",
                       distance_km=2.5, sequence=1, kind="split"),
            Checkpoint(event_id=ev.id, race_id=long_.id, name="5K Finish",
                       distance_km=5, sequence=2, kind="finish"),
        ])
        db.commit()
        print("  Created the 'demo' practice event (RACETIME_NO_DEMO=1 to skip).")
    except Exception as e:                      # noqa: BLE001
        # A demo race is a nicety. It must never be the reason a deployment
        # fails to boot.
        db.rollback()
        print(f"  Could not create the demo event: {type(e).__name__}: {e}")
    finally:
        db.close()


def _seed_accounts():
    """Create the starting operator accounts if the table is empty.

    Wrapped like the demo event: a first-run convenience must not be able to
    stop an existing deployment from starting.
    """
    db = SessionLocal()
    try:
        auth.seed_users(db)
    except Exception as e:                      # noqa: BLE001
        db.rollback()
        print(f"  Could not seed accounts: {type(e).__name__}: {e}")
    finally:
        db.close()


# These two were below the seeding until 2026-10-05, which is the shape of the
# outage on 2026-09-28: the demo-event seed reads races, checkpoints and
# participants, so on a database predating `race_id` it was querying a column
# that did not exist yet. It never brought the site down only because the seed
# is wrapped -- the import survived and the seeding silently did not happen.
# Migrations run before anything that reads the schema. All of them.
_add_missing_columns("checkpoints", {"race_id": "INTEGER"})
_add_missing_columns("participants", {"race_id": "INTEGER", "gender": "VARCHAR(16)"})
_backfill_default_race()

_seed_accounts()
_seed_demo_event()

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
# Who is signed in
#
# Accounts and roles live in backend/auth.py. What sits here is the wiring:
# every request looks up its session once, and endpoints declare the role they
# need. The single shared ADMIN_TOKEN is gone -- it could not say who did
# something, could not be withdrawn from one person, and handed a volunteer
# exactly the same power as the race director.
# --------------------------------------------------------------------------

@app.middleware("http")
async def _attach_user(request: Request, call_next):
    """Resolve the session cookie once per request.

    A request with no cookie -- every public results view, every scan posted
    from a checkpoint -- costs nothing: there is no query to make.
    """
    request.state.user_id = None
    raw = request.cookies.get(auth.COOKIE_NAME)
    if raw:
        db = SessionLocal()
        try:
            request.state.user_id = auth.resolve_session(db, raw)
        finally:
            db.close()

    response = await call_next(request)

    # Count the visit, but only once the page actually loaded -- a 404 or a
    # redirect to the sign-in screen is not somebody reading the results.
    if request.method == "GET" and response.status_code < 400:
        wanted, code = analytics.what_to_record(request.url.path)
        if wanted:
            db = SessionLocal()
            try:
                analytics.record(db, request, request.url.path, code)
            finally:
                db.close()
    return response


ADMIN = auth.ADMIN          # admin or super admin
SUPER = auth.SUPER          # super admin only


def _me(user: models.User) -> schemas.MeOut:
    return schemas.MeOut(
        user=schemas.UserOut.model_validate(user),
        can_create_events=user.is_super,
        can_manage_users=user.is_super,
    )


@app.post("/api/auth/login", response_model=schemas.MeOut)
def login(payload: schemas.LoginIn, request: Request, response: Response,
          db: Session = Depends(get_db)):
    """Exchange a username and password for a session cookie.

    One message for every kind of failure. Saying "no such user" would let
    anyone enumerate who has an account here.
    """
    user = (db.query(models.User)
            .filter(models.User.username == payload.username.strip().lower())
            .first())
    if user is None or not user.is_active or not auth.verify_password(
            payload.password, user.password_hash):
        raise HTTPException(401, "That username and password do not match.")

    # Quietly bring an old hash up to the current iteration count while the
    # plaintext is in hand -- the only moment it is possible.
    if auth.needs_rehash(user.password_hash):
        user.password_hash = auth.hash_password(payload.password)

    auth.start_session(db, user, response, request)
    auth.purge_expired(db)
    return _me(user)


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request, db: Session = Depends(get_db)):
    auth.end_session(db, request.cookies.get(auth.COOKIE_NAME))
    response = Response(status_code=204)
    auth.clear_cookie(response)
    return response


@app.get("/api/auth/me", response_model=schemas.MeOut)
def whoami(user: models.User = Depends(auth.require_user)):
    return _me(user)


@app.post("/api/auth/password", status_code=204)
def change_password(payload: schemas.PasswordChangeIn, request: Request,
                    user: models.User = Depends(auth.require_user),
                    db: Session = Depends(get_db)):
    """Change your own password. Signs out every other browser.

    A password change is usually a response to suspecting someone else has it,
    so leaving their sessions alive would defeat the point.
    """
    if not auth.verify_password(payload.current_password, user.password_hash):
        raise HTTPException(403, "Your current password is not correct.")
    if payload.new_password == payload.current_password:
        raise HTTPException(422, "The new password must be different.")
    if payload.new_password.strip().lower() == user.username:
        raise HTTPException(422, "Your password cannot be your username.")

    user.password_hash = auth.hash_password(payload.new_password)
    user.must_change_password = False
    keep = auth.token_hash(request.cookies.get(auth.COOKIE_NAME) or "")
    db.query(models.Session).filter(
        models.Session.user_id == user.id,
        models.Session.token_hash != keep).delete(synchronize_session=False)
    db.commit()
    return Response(status_code=204)


# --------------------------------------------------------------------------
# Member management -- super admin only
# --------------------------------------------------------------------------

def _super_admin_count(db: Session) -> int:
    return (db.query(models.User)
            .filter(models.User.role == "super_admin",
                    models.User.is_active.is_(True))
            .count())


@app.get("/api/users", response_model=List[schemas.UserOut], dependencies=SUPER)
def list_users(db: Session = Depends(get_db)):
    return db.query(models.User).order_by(models.User.username).all()


@app.post("/api/users", response_model=schemas.UserOut, status_code=201,
          dependencies=SUPER)
def create_user(payload: schemas.UserIn, db: Session = Depends(get_db)):
    username = payload.username.strip().lower()
    if db.query(models.User).filter(models.User.username == username).first():
        raise HTTPException(409, f"There is already an account called '{username}'.")
    if payload.password.strip().lower() == username:
        raise HTTPException(422, "The password cannot be the username.")
    user = models.User(
        username=username,
        display_name=(payload.display_name or payload.username).strip(),
        password_hash=auth.hash_password(payload.password),
        role=payload.role,
        must_change_password=True,   # they choose their own on first sign-in
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@app.patch("/api/users/{user_id}", response_model=schemas.UserOut,
           dependencies=SUPER)
def update_user(user_id: int, payload: schemas.UserPatch,
                actor: models.User = Depends(auth.require_super_admin),
                db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(404, "No such account.")

    data = payload.model_dump(exclude_unset=True)

    # You cannot demote or disable yourself. Locking the last super admin out
    # of their own system is a support call nobody can answer.
    if user.id == actor.id:
        if data.get("role") and data["role"] != user.role:
            raise HTTPException(422, "You cannot change your own role.")
        if data.get("is_active") is False:
            raise HTTPException(422, "You cannot disable your own account.")

    # Nor may the last one standing be taken out by anyone else.
    demoting = bool(data.get("role")) and data["role"] != "super_admin"
    if (demoting or data.get("is_active") is False) and user.is_super:
        if _super_admin_count(db) <= 1:
            raise HTTPException(
                422, "This is the only super admin. Promote someone else first.")

    new_password = data.pop("password", None)
    if new_password:
        if new_password.strip().lower() == user.username:
            raise HTTPException(422, "The password cannot be the username.")
        user.password_hash = auth.hash_password(new_password)
        user.must_change_password = True
        # A reset exists because an account may be compromised, so end its
        # sessions rather than leaving whoever holds one signed in.
        db.query(models.Session).filter(
            models.Session.user_id == user.id).delete(synchronize_session=False)

    for field, value in data.items():
        setattr(user, field, value)

    # Disabling an account must also close the door behind it.
    if data.get("is_active") is False:
        db.query(models.Session).filter(
            models.Session.user_id == user.id).delete(synchronize_session=False)

    db.commit()
    db.refresh(user)
    return user


@app.delete("/api/users/{user_id}", status_code=204, dependencies=SUPER)
def delete_user(user_id: int,
                actor: models.User = Depends(auth.require_super_admin),
                db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(404, "No such account.")
    if user.id == actor.id:
        raise HTTPException(422, "You cannot delete your own account.")
    if user.is_super and _super_admin_count(db) <= 1:
        raise HTTPException(422, "This is the only super admin.")
    db.delete(user)
    db.commit()
    return Response(status_code=204)


@app.get("/api/analytics", dependencies=ADMIN)
def site_analytics(days: int = 30, db: Session = Depends(get_db)):
    """Traffic for the whole site.

    Open to any signed-in operator, not just a super admin: knowing how many
    people are watching is part of running a race, and it names nobody.
    """
    days = max(1, min(90, days))
    return analytics.summary(db, days)


@app.post("/api/analytics/prune", dependencies=SUPER)
def prune_analytics(db: Session = Depends(get_db)):
    return {"removed": analytics.prune(db)}


# --------------------------------------------------------------------------
# Runners: their account, their record, their entries
# --------------------------------------------------------------------------

def _make_slug(db: Session, display_name: str, username: str) -> str:
    """A readable handle for a profile URL.

    Derived from the name, not from the database id: /r/tenzing-bhutia is
    something a runner will send to their family, and /r/47 tells anyone who
    receives it how many accounts exist.
    """
    base = re.sub(r"[^a-z0-9]+", "-", (display_name or username).lower()).strip("-")
    base = (base or "runner")[:40]
    slug = base
    n = 2
    while db.query(models.User).filter(models.User.slug == slug).first():
        slug = f"{base}-{n}"
        n += 1
    return slug


def _clean_email(value: str) -> str:
    """Not full RFC validation, which rejects addresses that work. Enough to
    catch a typo before it becomes an account nobody can recover."""
    email = (value or "").strip().lower()
    if "@" not in email or "." not in email.split("@")[-1] or " " in email:
        raise HTTPException(422, "That does not look like an email address.")
    return email


@app.post("/api/auth/signup", response_model=schemas.MeOut, status_code=201)
def sign_up(payload: schemas.SignUpIn, request: Request, response: Response,
            db: Session = Depends(get_db)):
    """Open a runner account.

    The role is hard-coded, never taken from the body. A public form that
    accepted a role field would be a public form for making super admins.
    """
    username = payload.username.strip().lower()
    email = _clean_email(payload.email)

    if db.query(models.User).filter(models.User.username == username).first():
        raise HTTPException(409, f"The name '{username}' is taken.")
    if db.query(models.User).filter(models.User.email == email).first():
        raise HTTPException(409, "There is already an account with that email.")
    if payload.password.strip().lower() == username:
        raise HTTPException(422, "Your password cannot be your username.")

    if not payload.consent:
        raise HTTPException(
            422, "Please agree to how your details are used before continuing.")

    user = models.User(
        username=username,
        display_name=payload.display_name.strip(),
        email=email,
        phone=(payload.phone or "").strip() or None,
        home_town=(payload.home_town or "").strip() or None,
        birth_year=payload.birth_year,
        password_hash=auth.hash_password(payload.password),
        role="runner",
        must_change_password=False,     # they just chose it
        # Private until they say otherwise. Every time.
        visibility="private",
        consented_at=utcnow(),
        slug=_make_slug(db, payload.display_name, username),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    auth.start_session(db, user, response, request)
    return _me(user)


@app.get("/api/me/profile", response_model=schemas.UserOut)
def my_profile(user: models.User = Depends(auth.require_user)):
    return user


@app.patch("/api/me/profile", response_model=schemas.UserOut)
def update_my_profile(payload: schemas.ProfileIn,
                      user: models.User = Depends(auth.require_user),
                      db: Session = Depends(get_db)):
    data = payload.model_dump(exclude_unset=True)
    if "email" in data and data["email"]:
        email = _clean_email(data["email"])
        clash = (db.query(models.User)
                 .filter(models.User.email == email, models.User.id != user.id)
                 .first())
        if clash:
            raise HTTPException(409, "Another account already uses that email.")
        data["email"] = email
    # A minor cannot publish a profile, whatever the form sent. The client
    # hides the option; this is the part that actually holds.
    if data.get("visibility") in ("public", "members"):
        year = data.get("birth_year", user.birth_year)
        if year and (utcnow().year - year) < 18:
            raise HTTPException(
                422, "An account for someone under 18 cannot have a public profile.")

    if data.get("strava_url"):
        url = data["strava_url"].strip()
        if not url.startswith(("https://www.strava.com/", "https://strava.com/")):
            raise HTTPException(422, "That does not look like a Strava profile link.")
        data["strava_url"] = url

    for field, value in data.items():
        setattr(user, field, (value.strip() or None) if isinstance(value, str) else value)

    if not user.slug:
        user.slug = _make_slug(db, user.display_name, user.username)
    db.commit()
    db.refresh(user)
    return user


@app.get("/api/profiles/{slug}", response_model=schemas.PublicProfileOut)
def public_profile(slug: str, request: Request, db: Session = Depends(get_db)):
    """Somebody else's runner profile.

    Answers 404 rather than 403 when it may not be seen. A 403 would confirm
    that the account exists, which is itself something the owner did not agree
    to publish.
    """
    user = db.query(models.User).filter(models.User.slug == slug).first()
    viewer = auth.optional_user(request, db)
    if user is None or not user.profile_visible_to(viewer):
        raise HTTPException(404, "No such profile, or it is not public.")

    record = achievements.profile(db, user)
    return schemas.PublicProfileOut(
        slug=user.slug,
        display_name=user.display_name or user.username,
        home_town=user.home_town,
        bio=user.bio,
        running_since=user.running_since,
        preferred_distances=user.preferred_distances,
        strava_url=user.strava_url,
        avatar_url=user.avatar_url,
        visibility=user.visibility,
        points=record["points"],
        stats=record["stats"],
        # The race list without the scoring breakdown, which is the runner's
        # own business rather than a visitor's.
        runs=[{k: r[k] for k in ("event_code", "event_name", "date", "race",
                                 "distance_km", "status", "finish_seconds",
                                 "position", "field_size", "certificate")}
              for r in record["runs"]],
        badges=[b for b in record["badges"] if b["earned"]],
    )


@app.post("/api/me/avatar", response_model=schemas.UserOut)
async def upload_avatar(request: Request, file: UploadFile = File(...),
                        user: models.User = Depends(auth.require_user),
                        db: Session = Depends(get_db)):
    blob = await file.read()
    if not blob:
        raise HTTPException(422, "That file is empty")
    if len(blob) > MAX_ARTWORK_BYTES:
        raise HTTPException(
            413, f"The photo must be under {MAX_ARTWORK_BYTES // (1024 * 1024)} MB")
    user.avatar_type = _sniff_image(blob)
    user.avatar_blob = blob
    user.avatar_url = f"/api/profiles/{user.slug}/avatar?v={secrets.token_hex(4)}"
    db.commit()
    db.refresh(user)
    return user


@app.get("/api/profiles/{slug}/avatar")
def get_avatar(slug: str, request: Request, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.slug == slug).first()
    viewer = auth.optional_user(request, db)
    if user is None or not user.avatar_blob or not user.profile_visible_to(viewer):
        raise HTTPException(404, "No photo")
    return Response(
        content=user.avatar_blob,
        media_type=user.avatar_type or "application/octet-stream",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@app.delete("/api/me/avatar", response_model=schemas.UserOut)
def clear_avatar(user: models.User = Depends(auth.require_user),
                 db: Session = Depends(get_db)):
    user.avatar_blob = None
    user.avatar_type = None
    user.avatar_url = None
    db.commit()
    db.refresh(user)
    return user


@app.get("/api/me/record")
def my_record(user: models.User = Depends(auth.require_user),
              db: Session = Depends(get_db)):
    """Races, points and badges. Derived from reads on every call, like the
    leaderboard -- so voiding a bad scan corrects a total with no recount."""
    return achievements.profile(db, user)


@app.get("/api/me/registrations", response_model=List[schemas.RegistrationOut])
def my_registrations(user: models.User = Depends(auth.require_user),
                     db: Session = Depends(get_db)):
    rows = (db.query(models.Registration)
            .filter(models.Registration.user_id == user.id)
            .order_by(models.Registration.created_at.desc())
            .all())
    return [_registration_out(db, r) for r in rows]


# A run that is accepted and a run that is flagged both count towards the
# distance. Only a rejection takes one out, which is what makes flagging safe
# to do automatically.
COUNTS_TOWARDS = ("accepted", "flagged")
SETTLED = ("paid", "waived")


def _progress(db: Session, reg: models.Registration) -> dict:
    """How far somebody has got in a virtual race. Summed, never stored.

    The same rule as results: the submissions are the record, the total is a
    calculation. Rejecting a run two weeks later changes a status and the next
    read of this gives the new answer -- there is nothing to recalculate and
    write back, and so nothing that can disagree with the evidence.
    """
    rows = (db.query(models.RunSubmission)
            .filter(models.RunSubmission.registration_id == reg.id).all())
    counted = [r for r in rows if r.status in COUNTS_TOWARDS]
    done = round(sum(r.distance_km for r in counted), 3)
    target = (reg.race.distance_km if reg.race else 0.0) or 0.0
    # A tenth of a kilometre of slack. A watch that calls 10K 9.98 has not
    # failed to finish, and nobody should be arguing with a GPS over 20 metres.
    complete = bool(target) and done >= target - 0.1
    owes = (reg.amount_paise or 0) > 0 and (reg.payment_status or "unpaid") not in SETTLED
    return dict(
        done_km=done, target_km=target, runs_counted=len(counted),
        runs_flagged=sum(1 for r in counted if r.status == "flagged"),
        complete=complete,
        # A certificate needs the distance done *and* the entry settled. An
        # unpaid certificate is a free race with extra steps.
        certificate_ready=bool(complete and not owes
                               and reg.status not in ("withdrawn", "rejected")),
    )


def _registration_out(db: Session, r: models.Registration) -> schemas.RegistrationOut:
    virtual = bool(r.event and r.event.is_virtual)
    bib = None
    if r.status == "confirmed":
        entry = (db.query(models.Participant)
                 .filter(models.Participant.event_id == r.event_id,
                         models.Participant.user_id == r.user_id)
                 .first())
        bib = entry.bib if entry else None
    return schemas.RegistrationOut(
        id=r.id,
        event_code=r.event.code if r.event else "",
        event_name=r.event.name if r.event else "",
        race_id=r.race_id,
        race=r.race.name if r.race else None,
        status=r.status,
        category=r.category,
        gender=r.gender,
        emergency_contact=r.emergency_contact,
        note=r.note,
        created_at=r.created_at,
        runner=(r.user.display_name or r.user.username) if r.user else None,
        username=r.user.username if r.user else None,
        email=r.user.email if r.user else None,
        phone=r.user.phone if r.user else None,
        bib=bib,
        payment_status=r.payment_status or "unpaid",
        amount_paise=r.amount_paise or 0,
        payment_ref=r.payment_ref,
        paid_at=r.paid_at,
        ship_address=r.ship_address,
        ship_phone=r.ship_phone,
        is_virtual=virtual,
        # Only for a virtual race: an ordinary race pays nothing for a query
        # per entry that would always answer zero.
        **(_progress(db, r) if virtual else {}),
    )


# --------------------------------------------------------------------------
# Upcoming events, and entering them
# --------------------------------------------------------------------------

@app.get("/api/events/upcoming", response_model=List[schemas.EventPublicOut])
def upcoming_events(request: Request, db: Session = Depends(get_db)):
    """Published events, soonest first. Public.

    Unpublished events are invisible here whatever their date, so an organiser
    can set one up over several sittings without half of it appearing on the
    site.
    """
    user = auth.optional_user(request, db)
    events = (db.query(Event)
              .filter(Event.is_published.is_(True))
              .order_by(Event.starts_at.is_(None), Event.starts_at.asc())
              .all())

    out = []
    for ev in events:
        mine = None
        if user is not None:
            reg = (db.query(models.Registration)
                   .filter(models.Registration.event_id == ev.id,
                           models.Registration.user_id == user.id)
                   .first())
            mine = reg.status if reg else None
        entrants = (db.query(models.Registration)
                    .filter(models.Registration.event_id == ev.id,
                            models.Registration.status.in_(("pending", "confirmed")))
                    .count())
        out.append(schemas.EventPublicOut(
            code=ev.code, name=ev.name, starts_at=ev.starts_at,
            location=ev.location, description=ev.description,
            entry_note=ev.entry_note,
            photo_url=ev.photo_url, photo_credit=ev.photo_credit,
            registration_open=bool(ev.registration_open),
            is_virtual=bool(ev.is_virtual), ends_at=ev.ends_at,
            races=[schemas.RaceOut.model_validate(r) for r in ev.races],
            entrants=entrants, my_status=mine,
        ))
    return out


@app.patch("/api/events/{code}/schedule", response_model=schemas.EventOut,
           dependencies=ADMIN)
def set_schedule(code: str, payload: schemas.EventScheduleIn,
                 db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(ev, field, value)
    db.commit()
    db.refresh(ev)
    return ev


@app.post("/api/events/{code}/register", response_model=schemas.RegistrationOut,
          status_code=201)
def register_for_event(code: str, payload: schemas.RegistrationIn,
                       user: models.User = Depends(auth.require_user),
                       db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    if not ev.is_published or not ev.registration_open:
        raise HTTPException(409, "Entries are not open for this race.")
    # A virtual race whose window has closed is over, whatever the entries
    # switch still says -- there is no longer any time in which to run it.
    if ev.is_virtual and ev.ends_at and utcnow() > _aware(ev.ends_at):
        raise HTTPException(409, "This virtual race has finished.")

    existing = (db.query(models.Registration)
                .filter(models.Registration.event_id == ev.id,
                        models.Registration.user_id == user.id)
                .first())
    if existing and existing.status in ("pending", "confirmed"):
        raise HTTPException(409, "You have already entered this race.")

    race_id = _resolve_race_id(ev, payload.race_id)

    if existing:                 # withdrawn or rejected: let them come back
        existing.status = "pending"
        existing.race_id = race_id
        existing.category = payload.category
        existing.gender = payload.gender
        existing.emergency_contact = payload.emergency_contact
        existing.note = payload.note
        existing.ship_address = payload.ship_address
        existing.ship_phone = payload.ship_phone
        # They are entering again, possibly at a different distance, so the
        # price is taken again. What they have already paid is not wiped.
        existing.amount_paise = _price_of(db, race_id)
        existing.decided_at = None
        db.commit()
        db.refresh(existing)
        return _registration_out(db, existing)

    reg = models.Registration(
        event_id=ev.id, user_id=user.id, race_id=race_id,
        category=payload.category, gender=payload.gender,
        emergency_contact=payload.emergency_contact, note=payload.note,
        ship_address=payload.ship_address, ship_phone=payload.ship_phone,
        amount_paise=_price_of(db, race_id),
    )
    db.add(reg)
    db.commit()
    db.refresh(reg)
    return _registration_out(db, reg)


@app.post("/api/registrations/{reg_id}/withdraw",
          response_model=schemas.RegistrationOut)
def withdraw(reg_id: int, user: models.User = Depends(auth.require_user),
             db: Session = Depends(get_db)):
    reg = db.get(models.Registration, reg_id)
    if reg is None:
        raise HTTPException(404, "No such entry.")
    # A runner may withdraw their own; an organiser may withdraw anyone's.
    if reg.user_id != user.id and not user.is_operator:
        raise HTTPException(403, "That is not your entry.")
    reg.status = "withdrawn"
    reg.decided_at = utcnow()
    # If a bib had been assigned, take it off the start list as well, or the
    # race would run with somebody entered who has pulled out.
    db.query(models.Participant).filter(
        models.Participant.event_id == reg.event_id,
        models.Participant.user_id == reg.user_id).delete(synchronize_session=False)
    db.commit()
    db.refresh(reg)
    return _registration_out(db, reg)


@app.get("/api/events/{code}/registrations",
         response_model=List[schemas.RegistrationOut], dependencies=ADMIN)
def list_registrations(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    rows = (db.query(models.Registration)
            .filter(models.Registration.event_id == ev.id)
            .order_by(models.Registration.created_at.asc())
            .all())
    return [_registration_out(db, r) for r in rows]


@app.patch("/api/registrations/{reg_id}", response_model=schemas.RegistrationOut,
           dependencies=ADMIN)
def decide_registration(reg_id: int, payload: schemas.RegistrationDecision,
                        db: Session = Depends(get_db)):
    """Accept, reject or reopen an entry.

    Confirming is the moment a request becomes a bib on the start list, so it
    is also the moment a Participant appears -- linked to the account, which is
    what lets the runner's own page find the result afterwards.
    """
    reg = db.get(models.Registration, reg_id)
    if reg is None:
        raise HTTPException(404, "No such entry.")
    ev = reg.event

    if payload.status == "confirmed" and ev.is_virtual:
        # Nobody pins a number on for a virtual race: there is no start line to
        # identify anybody at. Confirming it just means the entry is accepted,
        # and no Participant is created, so the start list stays a start list.
        reg.status = "confirmed"
        reg.race_id = _resolve_race_id(ev, payload.race_id or reg.race_id)
        reg.decided_at = utcnow()
        db.commit()
        db.refresh(reg)
        return _registration_out(db, reg)

    if payload.status == "confirmed":
        bib = (payload.bib or "").strip()
        if not bib:
            raise HTTPException(422, "Give them a bib number to confirm the entry.")
        race_id = _resolve_race_id(ev, payload.race_id or reg.race_id)

        clash = (db.query(models.Participant)
                 .filter(models.Participant.event_id == ev.id,
                         models.Participant.bib == bib)
                 .first())
        if clash and clash.user_id != reg.user_id:
            raise HTTPException(409, f"Bib {bib} is already taken in this race.")

        entry = (db.query(models.Participant)
                 .filter(models.Participant.event_id == ev.id,
                         models.Participant.user_id == reg.user_id)
                 .first())
        if entry is None:
            entry = models.Participant(event_id=ev.id, user_id=reg.user_id)
            db.add(entry)
        entry.bib = bib
        entry.name = reg.user.display_name or reg.user.username
        entry.category = reg.category
        entry.gender = reg.gender
        entry.race_id = race_id
        reg.race_id = race_id
    else:
        # Anything other than confirmed means they are not on the start list.
        db.query(models.Participant).filter(
            models.Participant.event_id == reg.event_id,
            models.Participant.user_id == reg.user_id).delete(
                synchronize_session=False)

    reg.status = payload.status
    reg.decided_at = utcnow()
    db.commit()
    db.refresh(reg)
    return _registration_out(db, reg)


# --------------------------------------------------------------------------
# Virtual races
#
# A race nobody travels to. The organiser sets the distances, the prices and
# the window; entrants run where they live and send a photograph of the watch.
# Nothing here invents a second kind of event -- a virtual race is an Event
# with a flag, its distances are Races, and its entries are Registrations, so
# the certificate, the listing and the admin screens already work.
# --------------------------------------------------------------------------

# A single run, bounded by what a person can plausibly do and by what is
# plainly a typo. 500km in one go is not a run; 50m is not one either.
MIN_RUN_KM, MAX_RUN_KM = 0.1, 500.0
# 22 km/h sustained is faster than the marathon world record. Anything above it
# is a treadmill left running, a cycle logged as a run, or a mistyped time.
IMPLAUSIBLE_KMH = 22.0


def _aware(dt):
    """A stored datetime, with the UTC it was written in put back on.

    SQLite does not persist tzinfo even when the column says
    DateTime(timezone=True), so a value read back is naive while anything
    arriving from a request is aware -- and comparing the two raises. Output
    gets this through `as_utc` in schemas; comparisons need it here. It cost a
    500 on the first entry into the first virtual race.
    """
    if dt is None or dt.tzinfo is not None:
        return dt
    return dt.replace(tzinfo=timezone.utc)


def _price_of(db: Session, race_id: Optional[int]) -> int:
    """What a distance costs, read at the moment somebody enters.

    Snapshotted onto the registration rather than looked up later: if the
    organiser raises the price next week, what this entrant owes does not move.
    """
    if not race_id:
        return 0
    race = db.get(Race, race_id)
    return int(race.price_paise or 0) if race else 0


def _get_registration(db: Session, reg_id: int,
                      user: models.User) -> models.Registration:
    """Somebody's own entry, or anybody's if you are an operator."""
    reg = db.get(models.Registration, reg_id)
    if reg is None:
        raise HTTPException(404, "No such entry.")
    if reg.user_id != user.id and not user.is_operator:
        raise HTTPException(403, "That is not your entry.")
    return reg


def _run_out(r: models.RunSubmission) -> schemas.RunOut:
    who = None
    if r.registration is not None and r.registration.user is not None:
        u = r.registration.user
        who = u.display_name or u.username
    return schemas.RunOut(
        id=r.id, registration_id=r.registration_id, runner=who,
        distance_km=r.distance_km,
        ran_on=r.ran_on, duration_seconds=r.duration_seconds, source=r.source,
        note=r.note, evidence_url=r.evidence_url, status=r.status,
        flags=[f for f in (r.flags or "").split(",") if f],
        created_at=r.created_at,
    )


@app.get("/api/events/{code}/virtual", response_model=schemas.VirtualSetupOut,
         dependencies=ADMIN)
def get_virtual(code: str, db: Session = Depends(get_db)):
    """The virtual settings, including how entrants are asked to pay.

    Operator only, and deliberately not part of the public event response.
    """
    return _get_event(db, code)


@app.patch("/api/events/{code}/virtual",
           response_model=schemas.VirtualSetupOut, dependencies=ADMIN)
def set_virtual(code: str, payload: schemas.VirtualSetupIn,
                db: Session = Depends(get_db)):
    """Make an event a virtual race, and say how to pay for it.

    The prices live on the races, because the organiser prices each distance.
    """
    ev = _get_event(db, code)
    data = payload.model_dump(exclude_unset=True)
    if data.get("is_virtual") is False:
        entries = (db.query(models.Registration)
                   .filter(models.Registration.event_id == ev.id,
                           models.Registration.status.in_(("pending", "confirmed")))
                   .count())
        if entries:
            raise HTTPException(
                409, f"{entries} people have entered this as a virtual race. "
                     "Close entries instead of changing what kind of race it is.")
    for field, value in data.items():
        setattr(ev, field, value)
    if (ev.is_virtual and ev.starts_at and ev.ends_at
            and _aware(ev.ends_at) < _aware(ev.starts_at)):
        raise HTTPException(422, "The window closes before it opens.")
    db.commit()
    db.refresh(ev)
    return ev


@app.post("/api/events/{code}/payment-qr",
          response_model=schemas.VirtualSetupOut, dependencies=ADMIN)
async def upload_payment_qr(code: str, file: UploadFile = File(...),
                            db: Session = Depends(get_db)):
    """The organiser's own UPI QR code, as an image.

    Deliberately an upload rather than something generated from a UPI id: the
    code people scan should be the one the organiser already has and has
    already tested against their own bank, not one this app composed and
    nobody checked.
    """
    ev = _get_event(db, code)
    blob = await file.read()
    if not blob:
        raise HTTPException(422, "That file is empty")
    if len(blob) > MAX_ARTWORK_BYTES:
        raise HTTPException(
            413, f"The image must be under {MAX_ARTWORK_BYTES // (1024 * 1024)} MB")
    ev.payment_qr_type = _sniff_image(blob)
    ev.payment_qr_blob = blob
    ev.payment_qr_url = f"/api/events/{ev.code}/payment-qr?v={secrets.token_hex(4)}"
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/api/events/{code}/payment-qr")
def get_payment_qr(code: str, request: Request, db: Session = Depends(get_db)):
    """Shown to somebody who has entered, and to operators. Not to the public.

    It is a collection handle. On an open page it is an invitation to anybody
    who fancies printing their own version of this race.
    """
    ev = _get_event(db, code)
    viewer = auth.optional_user(request, db)
    if viewer is None:
        raise HTTPException(401, "Sign in to see how to pay.")
    if not viewer.is_operator:
        mine = (db.query(models.Registration)
                .filter(models.Registration.event_id == ev.id,
                        models.Registration.user_id == viewer.id,
                        models.Registration.status.in_(("pending", "confirmed")))
                .first())
        if mine is None:
            raise HTTPException(403, "Enter the race first.")
    if not ev.payment_qr_blob:
        raise HTTPException(404, "This race has no payment QR code")
    return Response(
        content=ev.payment_qr_blob,
        media_type=ev.payment_qr_type or "image/png",
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.delete("/api/events/{code}/payment-qr", status_code=204, dependencies=ADMIN)
def delete_payment_qr(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    ev.payment_qr_blob = None
    ev.payment_qr_type = None
    ev.payment_qr_url = None
    db.commit()


@app.get("/api/registrations/{reg_id}/payment",
         response_model=schemas.PaymentInfoOut)
def payment_info(reg_id: int, user: models.User = Depends(auth.require_user),
                 db: Session = Depends(get_db)):
    """What this entrant owes, and where to send it."""
    reg = _get_registration(db, reg_id, user)
    ev = reg.event
    return schemas.PaymentInfoOut(
        registration_id=reg.id,
        amount_paise=reg.amount_paise or 0,
        payment_status=reg.payment_status or "unpaid",
        payment_ref=reg.payment_ref,
        paid_at=reg.paid_at,
        upi_id=ev.upi_id if ev else None,
        upi_name=ev.upi_name if ev else None,
        payment_note=ev.payment_note if ev else None,
        qr_url=ev.payment_qr_url if ev else None,
    )


@app.post("/api/registrations/{reg_id}/payment",
          response_model=schemas.RegistrationOut)
def claim_payment(reg_id: int, payload: schemas.PaymentClaimIn,
                  user: models.User = Depends(auth.require_user),
                  db: Session = Depends(get_db)):
    """The entrant says they have sent the money, and gives the reference.

    This does not mark the entry paid. Only the organiser, looking at their own
    account, can do that -- a self-service "I have paid" button that counted
    would be an honour system with a spreadsheet attached.
    """
    reg = _get_registration(db, reg_id, user)
    if reg.user_id != user.id:
        raise HTTPException(403, "An organiser confirms payment, not claims it.")
    if (reg.amount_paise or 0) <= 0:
        raise HTTPException(409, "There is nothing to pay for this entry.")
    if (reg.payment_status or "unpaid") in SETTLED:
        raise HTTPException(409, "This entry is already settled.")
    reg.payment_ref = payload.payment_ref.strip()
    reg.payment_status = "claimed"
    db.commit()
    db.refresh(reg)
    return _registration_out(db, reg)


@app.patch("/api/registrations/{reg_id}/payment",
           response_model=schemas.RegistrationOut, dependencies=ADMIN)
def decide_payment(reg_id: int, payload: schemas.PaymentDecisionIn,
                   db: Session = Depends(get_db)):
    """The organiser, having found it in their account. Or waiving it."""
    reg = db.get(models.Registration, reg_id)
    if reg is None:
        raise HTTPException(404, "No such entry.")
    reg.payment_status = payload.payment_status
    reg.paid_at = utcnow() if payload.payment_status in SETTLED else None
    db.commit()
    db.refresh(reg)
    return _registration_out(db, reg)


def _flags_for(db: Session, reg: models.Registration, distance_km: float,
               ran_on: date, duration_seconds: Optional[int],
               has_evidence: bool) -> List[str]:
    """What looks wrong about a run, without refusing it.

    A flagged run still counts. The organiser gets a short list to look at
    instead of a queue of everything, and the runner is told what was queried
    rather than left guessing -- which is also how they fix a typo themselves.
    """
    flags = []
    if not has_evidence:
        flags.append("no-evidence")
    if duration_seconds and duration_seconds > 0:
        if distance_km / (duration_seconds / 3600.0) > IMPLAUSIBLE_KMH:
            flags.append("fast")
    target = (reg.race.distance_km if reg.race else 0.0) or 0.0
    if target and distance_km > target:
        flags.append("long")
    twin = (db.query(models.RunSubmission)
            .filter(models.RunSubmission.registration_id == reg.id,
                    models.RunSubmission.ran_on == ran_on,
                    models.RunSubmission.status.in_(COUNTS_TOWARDS))
            .all())
    if any(abs((x.distance_km or 0) - distance_km) < 0.05 for x in twin):
        flags.append("duplicate")
    return flags


@app.post("/api/registrations/{reg_id}/runs", response_model=schemas.RunOut,
          status_code=201)
async def submit_run(reg_id: int,
                     distance_km: float = Form(...),
                     ran_on: date = Form(...),
                     duration_seconds: Optional[int] = Form(None),
                     source: str = Form("app"),
                     note: Optional[str] = Form(None),
                     file: Optional[UploadFile] = File(None),
                     user: models.User = Depends(auth.require_user),
                     db: Session = Depends(get_db)):
    """One run, towards the distance. Accepted on arrival.

    Multipart because the evidence is a photograph of a watch or a screenshot
    of an app, and asking somebody to turn that into JSON is asking them not to
    bother.
    """
    reg = _get_registration(db, reg_id, user)
    if reg.user_id != user.id:
        raise HTTPException(403, "An organiser cannot run it for them.")
    ev = reg.event
    if not ev or not ev.is_virtual:
        raise HTTPException(409, "This is not a virtual race.")
    if reg.status in ("withdrawn", "rejected"):
        raise HTTPException(409, "This entry is not active.")

    if not (MIN_RUN_KM <= distance_km <= MAX_RUN_KM):
        raise HTTPException(
            422, f"A run has to be between {MIN_RUN_KM:g} and {MAX_RUN_KM:g} km.")
    today = utcnow().date()
    if ran_on > today:
        raise HTTPException(422, "That date has not happened yet.")
    # The window is the rule, not a plausibility check, so it refuses rather
    # than flags. A run from before the race opened is somebody else's run.
    if ev.starts_at and ran_on < ev.starts_at.date():
        raise HTTPException(
            422, f"This race opened on {ev.starts_at.date().isoformat()}.")
    if ev.ends_at and ran_on > ev.ends_at.date():
        raise HTTPException(
            422, f"This race closed on {ev.ends_at.date().isoformat()}.")
    if source not in ("app", "watch", "treadmill", "other"):
        source = "other"

    blob = await file.read() if file is not None else b""
    if blob and len(blob) > MAX_ARTWORK_BYTES:
        raise HTTPException(
            413, f"The screenshot must be under "
                 f"{MAX_ARTWORK_BYTES // (1024 * 1024)} MB")

    run = models.RunSubmission(
        registration_id=reg.id, distance_km=round(float(distance_km), 3),
        ran_on=ran_on, duration_seconds=duration_seconds or None,
        source=source, note=(note or None),
    )
    if blob:
        run.evidence_type = _sniff_image(blob)
        run.evidence_blob = blob
    flags = _flags_for(db, reg, run.distance_km, ran_on, run.duration_seconds,
                       bool(blob))
    run.flags = ",".join(flags) or None
    run.status = "flagged" if flags else "accepted"
    db.add(run)
    db.commit()
    db.refresh(run)
    if blob:
        run.evidence_url = f"/api/runs/{run.id}/evidence"
        db.commit()
        db.refresh(run)
    return _run_out(run)


@app.get("/api/registrations/{reg_id}/runs", response_model=List[schemas.RunOut])
def list_runs(reg_id: int, user: models.User = Depends(auth.require_user),
              db: Session = Depends(get_db)):
    reg = _get_registration(db, reg_id, user)
    rows = (db.query(models.RunSubmission)
            .filter(models.RunSubmission.registration_id == reg.id)
            .order_by(models.RunSubmission.ran_on.desc(),
                      models.RunSubmission.id.desc()).all())
    return [_run_out(r) for r in rows]


@app.get("/api/runs/{run_id}/evidence")
def run_evidence(run_id: int, user: models.User = Depends(auth.require_user),
                 db: Session = Depends(get_db)):
    """The screenshot. Private to the runner and the organisers.

    It is a picture of where somebody was and when, often with a map of the
    road outside their house on it. Results are public; this is not.
    """
    run = db.get(models.RunSubmission, run_id)
    if run is None or not run.evidence_blob:
        raise HTTPException(404, "No evidence for that run")
    reg = run.registration
    if reg is None or (reg.user_id != user.id and not user.is_operator):
        raise HTTPException(403, "That is not yours to look at.")
    return Response(
        content=run.evidence_blob,
        media_type=run.evidence_type or "image/jpeg",
        headers={"Cache-Control": "private, max-age=300"},
    )


@app.patch("/api/runs/{run_id}", response_model=schemas.RunOut, dependencies=ADMIN)
def decide_run(run_id: int, payload: schemas.RunDecisionIn,
               db: Session = Depends(get_db)):
    """An organiser clearing a flag, or rejecting a run.

    Rejecting takes the distance back out of the total on the next read. The
    row stays: it is what was submitted, and a race that quietly deletes
    somebody's evidence cannot answer a question about it later.
    """
    run = db.get(models.RunSubmission, run_id)
    if run is None:
        raise HTTPException(404, "No such run.")
    run.status = payload.status
    if payload.note:
        run.note = payload.note
    run.decided_at = utcnow()
    db.commit()
    db.refresh(run)
    return _run_out(run)


@app.delete("/api/runs/{run_id}", status_code=204)
def delete_run(run_id: int, user: models.User = Depends(auth.require_user),
               db: Session = Depends(get_db)):
    """A runner removing their own mistake, or an operator removing anything.

    Unlike a read, a submission is somebody's own entry about themselves, and
    the usual reason to remove one is that they typed 50 for 5.
    """
    run = db.get(models.RunSubmission, run_id)
    if run is None:
        return
    reg = run.registration
    if reg is None or (reg.user_id != user.id and not user.is_operator):
        raise HTTPException(403, "That is not your run.")
    db.delete(run)
    db.commit()


@app.get("/api/events/{code}/runs", response_model=List[schemas.RunOut],
         dependencies=ADMIN)
def event_runs(code: str, status: Optional[str] = None,
               db: Session = Depends(get_db)):
    """Every submission for a race, newest first. `?status=flagged` to review."""
    ev = _get_event(db, code)
    q = (db.query(models.RunSubmission)
         .join(models.Registration,
               models.RunSubmission.registration_id == models.Registration.id)
         .filter(models.Registration.event_id == ev.id))
    if status:
        q = q.filter(models.RunSubmission.status == status)
    rows = q.order_by(models.RunSubmission.id.desc()).all()
    return [_run_out(r) for r in rows]


@app.get("/api/events/{code}/shipping.csv", dependencies=ADMIN)
def shipping_csv(code: str, db: Session = Depends(get_db)):
    """Addresses for posting medals, for the people who have finished.

    Only the finishers, and only the settled ones: a list of everybody who
    entered is a list of parcels nobody owes.
    """
    ev = _get_event(db, code)
    regs = (db.query(models.Registration)
            .filter(models.Registration.event_id == ev.id,
                    models.Registration.status.in_(("pending", "confirmed")))
            .all())
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["name", "distance", "km_done", "phone", "address",
                "payment", "reference"])
    for r in regs:
        p = _progress(db, r)
        if not p["certificate_ready"]:
            continue
        w.writerow([
            (r.user.display_name or r.user.username) if r.user else "",
            r.race.name if r.race else "",
            f"{p['done_km']:g}",
            r.ship_phone or (r.user.phone if r.user else "") or "",
            (r.ship_address or "").replace("\n", ", "),
            r.payment_status or "unpaid",
            r.payment_ref or "",
        ])
    return Response(
        content=out.getvalue(), media_type="text/csv",
        headers={"Content-Disposition":
                 f'attachment; filename="{ev.code}-shipping.csv"',
                 "Cache-Control": "no-store"},
    )


# --------------------------------------------------------------------------
# Contact form
# --------------------------------------------------------------------------

@app.post("/api/messages", status_code=201)
def post_message(payload: schemas.MessageIn, request: Request,
                 db: Session = Depends(get_db)):
    """Anyone may write in, signed in or not.

    Saved first, emailed second. If mail is not configured the message is still
    kept and shown in Race admin, because losing what somebody wrote because
    SMTP was wrong is worse than having no form.
    """
    user = auth.optional_user(request, db)
    msg = models.Message(
        name=payload.name.strip(),
        email=_clean_email(payload.email),
        subject=payload.subject.strip(),
        body=payload.body.strip(),
        user_id=user.id if user else None,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    sent, error = mail.send_contact(msg.name, msg.email, msg.subject, msg.body)
    if sent:
        msg.emailed = True
        db.commit()
    return {"ok": True, "emailed": sent, "id": msg.id,
            "detail": None if sent else error}


@app.get("/api/messages", response_model=List[schemas.MessageOut],
         dependencies=ADMIN)
def list_messages(db: Session = Depends(get_db)):
    rows = (db.query(models.Message)
            .order_by(models.Message.created_at.desc())
            .limit(200).all())
    return [schemas.MessageOut(
        id=m.id, created_at=m.created_at, name=m.name, email=m.email,
        subject=m.subject, body=m.body, emailed=m.emailed, handled=m.handled,
        username=m.user.username if m.user else None) for m in rows]


@app.patch("/api/messages/{msg_id}", response_model=schemas.MessageOut,
           dependencies=ADMIN)
def mark_message(msg_id: int, handled: bool = True, db: Session = Depends(get_db)):
    msg = db.get(models.Message, msg_id)
    if msg is None:
        raise HTTPException(404, "No such message.")
    msg.handled = handled
    db.commit()
    db.refresh(msg)
    return schemas.MessageOut(
        id=msg.id, created_at=msg.created_at, name=msg.name, email=msg.email,
        subject=msg.subject, body=msg.body, emailed=msg.emailed,
        handled=msg.handled, username=msg.user.username if msg.user else None)


@app.get("/api/mail/status", dependencies=ADMIN)
def mail_status():
    return mail.status()


# --------------------------------------------------------------------------
# Workshops
# --------------------------------------------------------------------------

LIVE_WS = ("registered", "attended")          # holds a place
ANY_WS = ("registered", "attended", "waitlisted")


def _ws_counts(db: Session, workshop: models.Workshop) -> tuple[int, int]:
    taken = (db.query(models.WorkshopRegistration)
             .filter(models.WorkshopRegistration.workshop_id == workshop.id,
                     models.WorkshopRegistration.status.in_(LIVE_WS))
             .count())
    waiting = (db.query(models.WorkshopRegistration)
               .filter(models.WorkshopRegistration.workshop_id == workshop.id,
                       models.WorkshopRegistration.status == "waitlisted")
               .count())
    return taken, waiting


def _ws_out(db: Session, w: models.Workshop,
            viewer: Optional[models.User]) -> schemas.WorkshopOut:
    taken, waiting = _ws_counts(db, w)
    mine = None
    if viewer is not None:
        reg = (db.query(models.WorkshopRegistration)
               .filter(models.WorkshopRegistration.workshop_id == w.id,
                       models.WorkshopRegistration.user_id == viewer.id)
               .first())
        mine = reg.status if reg else None
    # The joining link goes only to somebody who actually has a place, and to
    # the organisers. Publishing it on the listing would make the capacity
    # meaningless.
    link = None
    if w.mode == "online" and viewer is not None and (
            viewer.is_operator or mine in LIVE_WS):
        link = w.meeting_link
    return schemas.WorkshopOut(
        id=w.id, slug=w.slug, title=w.title, description=w.description,
        starts_at=w.starts_at, duration_minutes=w.duration_minutes,
        mode=w.mode, venue=w.venue, host_name=w.host_name,
        capacity=w.capacity, price_paise=w.price_paise, cover_url=w.cover_url,
        is_published=bool(w.is_published),
        registration_open=bool(w.registration_open),
        places_taken=taken,
        places_left=(max(0, w.capacity - taken) if w.capacity else None),
        waitlisted=waiting, my_status=mine, meeting_link=link,
    )


def _get_workshop(db: Session, slug: str) -> models.Workshop:
    w = db.query(models.Workshop).filter(models.Workshop.slug == slug).first()
    if w is None:
        raise HTTPException(404, f"No workshop called '{slug}'.")
    return w


def _promote_waitlist(db: Session, workshop: models.Workshop) -> int:
    """Move people off the waitlist into the places that just opened.

    In the order they joined it, which is the only order anybody would accept.
    """
    if not workshop.capacity:
        moved = (db.query(models.WorkshopRegistration)
                 .filter(models.WorkshopRegistration.workshop_id == workshop.id,
                         models.WorkshopRegistration.status == "waitlisted")
                 .all())
        for r in moved:
            r.status = "registered"
        return len(moved)

    taken, _ = _ws_counts(db, workshop)
    free = workshop.capacity - taken
    if free <= 0:
        return 0
    waiting = (db.query(models.WorkshopRegistration)
               .filter(models.WorkshopRegistration.workshop_id == workshop.id,
                       models.WorkshopRegistration.status == "waitlisted")
               .order_by(models.WorkshopRegistration.created_at.asc())
               .limit(free).all())
    for r in waiting:
        r.status = "registered"
    return len(waiting)


@app.get("/api/workshops", response_model=List[schemas.WorkshopOut])
def list_workshops(request: Request, db: Session = Depends(get_db)):
    """Published workshops, soonest first. Public.

    An operator sees the unpublished ones too, because otherwise setting one up
    means guessing at its address.
    """
    viewer = auth.optional_user(request, db)
    q = db.query(models.Workshop)
    if not (viewer and viewer.is_operator):
        q = q.filter(models.Workshop.is_published.is_(True))
    rows = q.order_by(models.Workshop.starts_at.is_(None),
                      models.Workshop.starts_at.asc()).all()
    return [_ws_out(db, w, viewer) for w in rows]


@app.get("/api/workshops/{slug}", response_model=schemas.WorkshopOut)
def get_workshop(slug: str, request: Request, db: Session = Depends(get_db)):
    viewer = auth.optional_user(request, db)
    w = _get_workshop(db, slug)
    if not w.is_published and not (viewer and viewer.is_operator):
        raise HTTPException(404, f"No workshop called '{slug}'.")
    return _ws_out(db, w, viewer)


@app.post("/api/workshops", response_model=schemas.WorkshopOut, status_code=201,
          dependencies=ADMIN)
def create_workshop(payload: schemas.WorkshopIn, request: Request,
                    db: Session = Depends(get_db)):
    base = re.sub(r"[^a-z0-9]+", "-", payload.title.lower()).strip("-")[:48] or "workshop"
    slug, n = base, 2
    while db.query(models.Workshop).filter(models.Workshop.slug == slug).first():
        slug = f"{base}-{n}"
        n += 1
    w = models.Workshop(slug=slug, **payload.model_dump())
    db.add(w)
    db.commit()
    db.refresh(w)
    return _ws_out(db, w, auth.optional_user(request, db))


@app.patch("/api/workshops/{slug}", response_model=schemas.WorkshopOut,
           dependencies=ADMIN)
def update_workshop(slug: str, payload: schemas.WorkshopPatch, request: Request,
                    db: Session = Depends(get_db)):
    w = _get_workshop(db, slug)
    data = payload.model_dump(exclude_unset=True)

    # Raising the capacity should let the people already waiting in.
    grew = "capacity" in data and (data["capacity"] or 0) > (w.capacity or 0)
    for field, value in data.items():
        setattr(w, field, value)
    if grew or data.get("capacity") is None and "capacity" in data:
        _promote_waitlist(db, w)
    db.commit()
    db.refresh(w)
    return _ws_out(db, w, auth.optional_user(request, db))


@app.delete("/api/workshops/{slug}", status_code=204, dependencies=ADMIN)
def delete_workshop(slug: str, db: Session = Depends(get_db)):
    w = _get_workshop(db, slug)
    attended = (db.query(models.WorkshopRegistration)
                .filter(models.WorkshopRegistration.workshop_id == w.id,
                        models.WorkshopRegistration.status == "attended")
                .count())
    if attended:
        # Somebody has a certificate from this. Deleting it would take that
        # away from them, which is not the organiser's to do by accident.
        raise HTTPException(
            409, f"{attended} people attended this workshop. Unpublish it "
                 "instead of deleting it.")
    db.delete(w)
    db.commit()
    return Response(status_code=204)


@app.post("/api/workshops/{slug}/cover", response_model=schemas.WorkshopOut,
          dependencies=ADMIN)
async def upload_workshop_cover(slug: str, request: Request,
                                file: UploadFile = File(...),
                                db: Session = Depends(get_db)):
    w = _get_workshop(db, slug)
    blob = await file.read()
    if not blob:
        raise HTTPException(422, "That file is empty")
    if len(blob) > MAX_ARTWORK_BYTES:
        raise HTTPException(
            413, f"The image must be under {MAX_ARTWORK_BYTES // (1024 * 1024)} MB")
    w.cover_type = _sniff_image(blob)
    w.cover_blob = blob
    w.cover_url = f"/api/workshops/{w.slug}/cover?v={secrets.token_hex(4)}"
    db.commit()
    db.refresh(w)
    return _ws_out(db, w, auth.optional_user(request, db))


@app.get("/api/workshops/{slug}/cover")
def get_workshop_cover(slug: str, db: Session = Depends(get_db)):
    w = _get_workshop(db, slug)
    if not w.cover_blob:
        raise HTTPException(404, "This workshop has no image")
    return Response(
        content=w.cover_blob,
        media_type=w.cover_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.post("/api/workshops/{slug}/register",
          response_model=schemas.WorkshopRegistrationOut, status_code=201)
def register_for_workshop(slug: str, user: models.User = Depends(auth.require_user),
                          db: Session = Depends(get_db)):
    """Take a place, or join the waitlist when the room is full."""
    w = _get_workshop(db, slug)
    if not w.is_published or not w.registration_open:
        raise HTTPException(409, "Registration is not open for this workshop.")

    existing = (db.query(models.WorkshopRegistration)
                .filter(models.WorkshopRegistration.workshop_id == w.id,
                        models.WorkshopRegistration.user_id == user.id)
                .first())
    if existing and existing.status in ANY_WS:
        raise HTTPException(409, "You are already on the list for this workshop.")

    taken, _ = _ws_counts(db, w)
    status = "waitlisted" if (w.capacity and taken >= w.capacity) else "registered"

    if existing:
        existing.status = status
        existing.created_at = utcnow()      # they rejoined; the queue is fair
        reg = existing
    else:
        reg = models.WorkshopRegistration(
            workshop_id=w.id, user_id=user.id, status=status)
        db.add(reg)
    db.commit()
    db.refresh(reg)
    return _ws_reg_out(db, reg)


def _ws_reg_out(db: Session,
                r: models.WorkshopRegistration) -> schemas.WorkshopRegistrationOut:
    return schemas.WorkshopRegistrationOut(
        id=r.id, workshop_id=r.workshop_id,
        workshop_title=r.workshop.title if r.workshop else "",
        workshop_slug=r.workshop.slug if r.workshop else "",
        starts_at=r.workshop.starts_at if r.workshop else None,
        status=r.status, created_at=r.created_at, attended_at=r.attended_at,
        note=r.note,
        runner=(r.user.display_name or r.user.username) if r.user else None,
        username=r.user.username if r.user else None,
        email=r.user.email if r.user else None,
        phone=r.user.phone if r.user else None,
    )


@app.post("/api/workshop-registrations/{reg_id}/cancel",
          response_model=schemas.WorkshopRegistrationOut)
def cancel_workshop(reg_id: int, user: models.User = Depends(auth.require_user),
                    db: Session = Depends(get_db)):
    reg = db.get(models.WorkshopRegistration, reg_id)
    if reg is None:
        raise HTTPException(404, "No such registration.")
    if reg.user_id != user.id and not user.is_operator:
        raise HTTPException(403, "That is not your place.")
    reg.status = "cancelled"
    db.commit()
    # A place just came free, so somebody on the waitlist gets it.
    _promote_waitlist(db, reg.workshop)
    db.commit()
    db.refresh(reg)
    return _ws_reg_out(db, reg)


@app.get("/api/me/workshops", response_model=List[schemas.WorkshopRegistrationOut])
def my_workshops(user: models.User = Depends(auth.require_user),
                 db: Session = Depends(get_db)):
    rows = (db.query(models.WorkshopRegistration)
            .filter(models.WorkshopRegistration.user_id == user.id)
            .order_by(models.WorkshopRegistration.created_at.desc()).all())
    return [_ws_reg_out(db, r) for r in rows]


@app.get("/api/workshops/{slug}/registrations",
         response_model=List[schemas.WorkshopRegistrationOut], dependencies=ADMIN)
def workshop_registrations(slug: str, db: Session = Depends(get_db)):
    w = _get_workshop(db, slug)
    rows = (db.query(models.WorkshopRegistration)
            .filter(models.WorkshopRegistration.workshop_id == w.id)
            .order_by(models.WorkshopRegistration.created_at.asc()).all())
    return [_ws_reg_out(db, r) for r in rows]


@app.patch("/api/workshop-registrations/{reg_id}",
           response_model=schemas.WorkshopRegistrationOut, dependencies=ADMIN)
def mark_attendance(reg_id: int, payload: schemas.AttendanceIn,
                    db: Session = Depends(get_db)):
    reg = db.get(models.WorkshopRegistration, reg_id)
    if reg is None:
        raise HTTPException(404, "No such registration.")
    was_live = reg.status in LIVE_WS
    reg.status = payload.status
    reg.attended_at = utcnow() if payload.status == "attended" else None
    db.commit()
    if was_live and payload.status not in LIVE_WS:
        _promote_waitlist(db, reg.workshop)
        db.commit()
    db.refresh(reg)
    return _ws_reg_out(db, reg)


# --------------------------------------------------------------------------
# Would you pay for any of this?
# --------------------------------------------------------------------------

@app.post("/api/interest", status_code=201)
def record_interest(payload: schemas.InterestIn, request: Request,
                    db: Session = Depends(get_db)):
    """Optional, and answerable once per context per person.

    Asked before anything is for sale, which is the only time the answer means
    anything -- afterwards you are asking people to justify a decision already
    taken.
    """
    user = auth.optional_user(request, db)
    row = models.InterestAnswer(
        user_id=user.id if user else None,
        context=payload.context,
        workshop_id=payload.workshop_id,
        would_pay_for=payload.would_pay_for,
        fair_price=payload.fair_price,
        comment=payload.comment,
    )
    db.add(row)
    db.commit()
    return {"ok": True}


@app.get("/api/admin/check")
def admin_check(request: Request, db: Session = Depends(get_db)):
    """What the browser needs in order to decide which screens to offer.

    Always 200. The previous version answered 401 to mean "protected", so the
    home page could not tell "this server has accounts" from "your session has
    expired" without guessing.
    """
    user = auth.optional_user(request, db)
    return {
        "protected": True,          # there is always an account system now
        "signed_in": user is not None,
        "role": user.role if user else None,
        # A runner is signed in but runs nothing, so the home page must not
        # offer them the organiser tools on the strength of a session alone.
        "is_operator": bool(user and user.is_operator),
        "display_name": (user.display_name or user.username) if user else None,
        "can_create_events": bool(user and user.is_super),
        "can_manage_users": bool(user and user.is_super),
        "must_change_password": bool(user and user.must_change_password),
    }


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
    if response.headers.get("cache-control"):
        # Artwork sets its own immutable caching and keeps it.
        return response

    if request.url.path.startswith("/api/"):
        # API responses are live race data, so they are never reused. Without
        # this they carry no directive at all and a browser caches them by
        # guesswork -- which meant a certificate kept showing branding the
        # organiser had already changed.
        response.headers["Cache-Control"] = "no-store"
    else:
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


# Creating a race commits the organisation to it -- codes end up on printed
# bibs and in shared links -- so it sits with the super admins.
@app.post("/api/events", response_model=schemas.EventOut, status_code=201,
          dependencies=SUPER)
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


@app.post("/api/events/{code}/certificate-artwork",
          response_model=schemas.EventOut, dependencies=ADMIN)
async def upload_cert_artwork(code: str, file: UploadFile = File(...),
                              db: Session = Depends(get_db)):
    """Artwork for the finisher card only.

    Separate from the bib because the two shapes disagree: a bib is landscape
    and a share card is 4:5 portrait, so one image centre-cropped into both
    always loses something. Leave this unset and the bib artwork is used, which
    is what every event did before this existed.
    """
    ev = _get_event(db, code)
    blob = await file.read()
    if not blob:
        raise HTTPException(422, "That file is empty")
    if len(blob) > MAX_ARTWORK_BYTES:
        raise HTTPException(
            413, f"Artwork must be under {MAX_ARTWORK_BYTES // (1024 * 1024)} MB")
    ev.cert_artwork_type = _sniff_image(blob)
    ev.cert_artwork_blob = blob
    ev.cert_artwork_url = (
        f"/api/events/{ev.code}/certificate-artwork?v={secrets.token_hex(4)}")
    db.commit()
    db.refresh(ev)
    return ev


@app.post("/api/events/{code}/photo", response_model=schemas.EventOut,
          dependencies=ADMIN)
async def upload_photo(code: str, file: UploadFile = File(...),
                       db: Session = Depends(get_db)):
    """A photograph of the race, for the listing and the results page.

    The third image an event can carry, and the only one that is a photograph.
    The bib artwork is a printed banner and the certificate background is a
    portrait card; neither is a picture of runners on the road, which is what
    makes a race worth clicking on.
    """
    ev = _get_event(db, code)
    blob = await file.read()
    if not blob:
        raise HTTPException(422, "That file is empty")
    if len(blob) > MAX_ARTWORK_BYTES:
        raise HTTPException(
            413, f"The photo must be under {MAX_ARTWORK_BYTES // (1024 * 1024)} MB")
    ev.photo_type = _sniff_image(blob)
    ev.photo_blob = blob
    ev.photo_url = f"/api/events/{ev.code}/photo?v={secrets.token_hex(4)}"
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/api/events/{code}/photo")
def get_photo(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    if not ev.photo_blob:
        raise HTTPException(404, "This race has no photo")
    return Response(
        content=ev.photo_blob,
        media_type=ev.photo_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.delete("/api/events/{code}/photo", response_model=schemas.EventOut,
            dependencies=ADMIN)
def clear_photo(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    ev.photo_url = None
    ev.photo_blob = None
    ev.photo_type = None
    ev.photo_credit = None
    db.commit()
    db.refresh(ev)
    return ev


@app.get("/api/events/{code}/certificate-artwork")
def get_cert_artwork(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    if not ev.cert_artwork_blob:
        raise HTTPException(404, "This event has no certificate artwork")
    return Response(
        content=ev.cert_artwork_blob,
        media_type=ev.cert_artwork_type or "application/octet-stream",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@app.delete("/api/events/{code}/certificate-artwork",
            response_model=schemas.EventOut, dependencies=ADMIN)
def clear_cert_artwork(code: str, db: Session = Depends(get_db)):
    ev = _get_event(db, code)
    ev.cert_artwork_url = None
    ev.cert_artwork_blob = None
    ev.cert_artwork_type = None
    db.commit()
    db.refresh(ev)
    return ev


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
def update_race(race_id: int, payload: schemas.RacePatch,
                db: Session = Depends(get_db)):
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
    rows = event_result_rows(db, ev)

    return {
        # Same here: hand-built dicts, so as_utc is applied at each timestamp.
        "event": {"code": ev.code, "name": ev.name,
                  "start_time": schemas.as_utc(ev.start_time),
                  "location": ev.location,
                  "photo_url": ev.photo_url, "photo_credit": ev.photo_credit},
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


# Pages that only an operator may see. Registered before the static mount, so
# these win over it. The API would refuse an anonymous caller anyway and the
# page would render empty -- but an admin screen that loads at all, for anyone
# who guesses the URL, is not something to leave standing.
@app.get("/r/{slug}", include_in_schema=False)
def profile_page(slug: str):
    """A runner's shareable address.

    /r/tenzing-bhutia is something somebody will send to their family;
    /profile.html#47 is not. The page decides nothing -- it asks the API, which
    applies the visibility rules and answers 404 when the profile may not be
    seen.
    """
    return FileResponse(STATIC_DIR / "profile.html",
                        headers={"Cache-Control": "no-cache, must-revalidate"})


@app.get("/admin.html", include_in_schema=False)
def admin_page(request: Request, db: Session = Depends(get_db)):
    # Not merely "is anyone signed in?" any more. Runners hold accounts too,
    # and a runner reaching the organiser's screen -- even an empty one whose
    # every request would be refused -- is not something to leave standing.
    user = auth.optional_user(request, db)
    if user is None or not user.is_operator:
        # 303 so the browser follows with GET, and `next` so signing in lands
        # back where they were headed rather than on the home page.
        # A signed-in runner is not asked to sign in again -- they already are.
        # They are sent to their own page, which is the one they wanted.
        if user is not None:
            return RedirectResponse("/me.html", status_code=303)
        return RedirectResponse("/login.html?next=%2Fadmin.html", status_code=303)
    return FileResponse(
        STATIC_DIR / "admin.html",
        headers={"Cache-Control": "no-store"},   # never cached by a shared proxy
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
