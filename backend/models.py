"""Data model.

The one rule that matters: `Read` is append-only and never edited or deleted.
Every scan the system has ever seen is kept exactly as it arrived. Results are
computed from reads on demand, never stored. When something goes wrong -- a
double scan, a volunteer's phone with a bad clock, a bib entered as 0042
instead of 42 -- you correct the computation and re-derive. The evidence is
still there.
"""
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Integer, LargeBinary, String,
    UniqueConstraint, Index,
)
from sqlalchemy.orm import relationship

from .db import Base


def utcnow():
    return datetime.now(timezone.utc)


class Event(Base):
    __tablename__ = "events"

    id = Column(Integer, primary_key=True)
    code = Column(String(24), unique=True, nullable=False, index=True)
    name = Column(String(200), nullable=False)
    # Gun start. A participant with a read at a `start` checkpoint uses that
    # instead, which is how you support wave starts or chip time later.
    start_time = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    # Branding, used by the printed bibs and the finisher certificate. The
    # artwork is stored as the web path it is served from, not a disk path, so
    # the frontend can drop it straight into a src/background-image.
    artwork_url = Column(String(255), nullable=True)
    # The image itself lives in the database, not on disk. A serverless host
    # gives every request a fresh, empty filesystem, so anything written to
    # static/uploads is gone by the next invocation. Race artwork is one small
    # image per event, so the row is cheap and it survives any host.
    artwork_blob = Column(LargeBinary, nullable=True)
    artwork_type = Column(String(32), nullable=True)
    # The certificate gets its own image. One upload cannot serve both: the bib
    # is a 180x132mm landscape card and the share card is 1080x1350 portrait,
    # so whichever way the artwork is composed, the other crop is wrong.
    # Null means "fall back to the bib artwork", which is the old behaviour.
    cert_artwork_url = Column(String(255), nullable=True)
    cert_artwork_blob = Column(LargeBinary, nullable=True)
    cert_artwork_type = Column(String(32), nullable=True)

    # placing | text | none. "placing" shows a rank only when it is genuinely an
    # achievement; "text" shows the same word to everyone, which is what a
    # school walk wants; "none" shows nothing at all.
    badge_mode = Column(String(8), nullable=True)
    badge_text = Column(String(40), nullable=True)
    # cover | contain. The card is 4:5, and an event poster rarely is -- a 1:2
    # banner filled to 4:5 loses its title and its sponsor footer to the crop.
    # "contain" fits the whole image in and pads the rest. Null means "cover",
    # which is what every event did before this existed.
    cert_fit = Column(String(8), nullable=True)

    accent_color = Column(String(16), nullable=True)
    # Free text under the race name: "12 October 2026 · Siliguri".
    tagline = Column(String(160), nullable=True)
    # full | band. "full" runs the artwork across the whole bib; "band" keeps it
    # to a strip at the top so the number sits on bare paper. Which one is right
    # depends on the printer and the paper, so it stays an organiser's choice.
    bib_style = Column(String(8), nullable=True)

    # --- the event as an entrant sees it, before race day ---
    # start_time above is the gun. This is the date in the poster, set when the
    # race is announced, which is what an upcoming-events list needs.
    starts_at = Column(DateTime(timezone=True), nullable=True)
    location = Column(String(160), nullable=True)
    description = Column(String(2000), nullable=True)
    # Nothing is visible to the public until an organiser says so, so a race
    # can be set up over several sittings without half of it being on the site.
    is_published = Column(Boolean, nullable=False, default=False)
    registration_open = Column(Boolean, nullable=False, default=False)
    entry_note = Column(String(400), nullable=True)

    # A photograph of the race -- runners on the road, the start line, the hill.
    # A third image on purpose: the bib artwork is a printed banner and the
    # certificate background is a portrait card, and neither is a photograph of
    # last year's race, which is what makes a listing worth looking at.
    photo_url = Column(String(255), nullable=True)
    photo_blob = Column(LargeBinary, nullable=True)
    photo_type = Column(String(32), nullable=True)
    photo_credit = Column(String(120), nullable=True)

    races = relationship(
        "Race", back_populates="event",
        cascade="all, delete-orphan", order_by="Race.sequence",
    )
    checkpoints = relationship(
        "Checkpoint", back_populates="event",
        cascade="all, delete-orphan", order_by="Checkpoint.sequence",
    )
    participants = relationship(
        "Participant", back_populates="event", cascade="all, delete-orphan",
    )


class Race(Base):
    """One distance within an event.

    "Kalimpong 5K & 10K" is a single event on a single morning with two races:
    separate courses, separate finish lines, separate rankings, and often
    separate guns. Every checkpoint and every participant belongs to exactly
    one race, and nobody is ever ranked against a field that ran a different
    distance.
    """
    __tablename__ = "races"

    id = Column(Integer, primary_key=True)
    event_id = Column(Integer, ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(80), nullable=False)
    distance_km = Column(Float, nullable=False, default=0.0)
    # Null means "use the event's gun". Set it for a staggered start, where the
    # 5K goes off half an hour after the 10K.
    start_time = Column(DateTime(timezone=True), nullable=True)
    sequence = Column(Integer, nullable=False, default=0)

    event = relationship("Event", back_populates="races")
    checkpoints = relationship(
        "Checkpoint", back_populates="race",
        cascade="all, delete-orphan", order_by="Checkpoint.sequence",
    )
    participants = relationship("Participant", back_populates="race")

    __table_args__ = (UniqueConstraint("event_id", "name", name="uq_race_name"),)


class Checkpoint(Base):
    __tablename__ = "checkpoints"

    id = Column(Integer, primary_key=True)
    event_id = Column(Integer, ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    race_id = Column(Integer, ForeignKey("races.id", ondelete="CASCADE"), nullable=True)
    name = Column(String(120), nullable=False)
    distance_km = Column(Float, nullable=False, default=0.0)
    sequence = Column(Integer, nullable=False, default=0)
    # start | split | finish
    kind = Column(String(16), nullable=False, default="split")

    event = relationship("Event", back_populates="checkpoints")
    race = relationship("Race", back_populates="checkpoints")

    # Names stay unique across the whole event, not just within a race. A
    # volunteer picking a checkpoint on their phone sees one flat list, so two
    # races both offering "Finish" would be a genuine hazard -- name them
    # "5K Finish" and "10K Finish".
    __table_args__ = (UniqueConstraint("event_id", "name", name="uq_checkpoint_name"),)


class Participant(Base):
    __tablename__ = "participants"

    id = Column(Integer, primary_key=True)
    event_id = Column(Integer, ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    race_id = Column(Integer, ForeignKey("races.id", ondelete="SET NULL"), nullable=True)
    bib = Column(String(24), nullable=False)
    name = Column(String(200), nullable=False)
    category = Column(String(60), nullable=True)
    # Free text: "Open", "Women", "Veteran", "Women 40-49". Ranking groups on
    # the exact string, so the start list has to be consistent.
    gender = Column(String(16), nullable=True)
    dnf = Column(Boolean, nullable=False, default=False)
    # Set when the entry came from a registered account, which is how a runner's
    # own page finds their races. Null for anyone entered from a CSV or typed in
    # on the day, and those stay perfectly valid entries.
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"),
                     nullable=True, index=True)

    event = relationship("Event", back_populates="participants")
    race = relationship("Race", back_populates="participants")

    # Bibs stay unique across the event even when races have separate number
    # series, because a scan carries a bib and nothing else.
    __table_args__ = (UniqueConstraint("event_id", "bib", name="uq_participant_bib"),)


class Read(Base):
    """One sighting of one bib at one checkpoint. Append-only.

    `read_id` is a UUID generated on the capture device at the moment of the
    scan, not by the server. That is what makes the ingest endpoint idempotent:
    a phone coming back from a dead zone can push the same batch as many times
    as it likes and the extra copies land on the same primary key and are
    discarded.
    """
    __tablename__ = "reads"

    read_id = Column(String(36), primary_key=True)
    event_id = Column(Integer, ForeignKey("events.id", ondelete="CASCADE"), nullable=False)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id", ondelete="CASCADE"), nullable=False)
    bib = Column(String(24), nullable=False)

    # Clock-corrected time of the sighting. This is what timing uses.
    observed_at = Column(DateTime(timezone=True), nullable=False)
    # The device's own uncorrected clock, plus the offset that was applied.
    # Kept purely so a disputed result can be audited afterwards.
    device_time = Column(DateTime(timezone=True), nullable=True)
    clock_offset_ms = Column(Integer, nullable=False, default=0)

    server_received_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    # qr | manual | rfid | import
    source = Column(String(16), nullable=False, default="qr")
    device_id = Column(String(64), nullable=True)
    voided = Column(Boolean, nullable=False, default=False)

    __table_args__ = (
        Index("ix_reads_lookup", "event_id", "bib", "checkpoint_id"),
    )


# --------------------------------------------------------------------------
# People who operate the system
#
# Separate from Participant on purpose: a runner is a row in a start list, an
# operator is someone who signs in and changes things. Conflating them would
# mean every runner needed a password and every operator an entry in a race.
# --------------------------------------------------------------------------

# Ordered weakest to strongest. Comparing by index is how a permission check
# stays a single expression rather than a chain of role names -- and why adding
# "runner" below the others required no change to a single existing endpoint:
# everything already demanded "admin or above".
ROLES = ("runner", "admin", "super_admin")


class User(Base):
    """An operator. Passwords are never stored, only a PBKDF2 digest."""
    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    # Lower-cased on the way in, so "Sanjay" and "sanjay" are one account and
    # the unique index actually holds.
    username = Column(String(40), unique=True, nullable=False, index=True)
    display_name = Column(String(80), nullable=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(16), nullable=False, default="runner")
    # Runners sign themselves up and need a way back in; operator accounts were
    # created by a super admin and may have none.
    email = Column(String(190), unique=True, nullable=True, index=True)
    phone = Column(String(32), nullable=True)
    home_town = Column(String(80), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    # Set when an account is created or reset by a super admin, so the app can
    # insist on a new password before it is used for anything.
    must_change_password = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_login_at = Column(DateTime(timezone=True), nullable=True)

    sessions = relationship(
        "Session", back_populates="user", cascade="all, delete-orphan")

    @property
    def is_super(self) -> bool:
        return self.role == "super_admin"

    @property
    def is_operator(self) -> bool:
        """Admin or above. A runner holds an account but runs nothing."""
        return ROLES.index(self.role) >= ROLES.index("admin")


class Session(Base):
    """A signed-in browser.

    Server-side rather than a self-contained token, because a session that
    cannot be revoked is not a session -- it is a password with an expiry date.
    Deleting the row signs that browser out immediately, everywhere.
    """
    __tablename__ = "sessions"

    # The raw token never touches the database: what is stored is its SHA-256,
    # so a leaked database backup does not hand over live sessions.
    token_hash = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_seen_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    # Enough to recognise your own sessions in a list; not a fingerprint.
    user_agent = Column(String(200), nullable=True)

    user = relationship("User", back_populates="sessions")


class PageView(Base):
    """One visit to one page.

    Deliberately thin. There is no cookie, no identifier that outlives a day,
    and no raw IP address anywhere in the table -- see `visitor` below. What it
    can answer is how many people looked, when, at what, and which race they
    cared about. What it cannot answer is who they were, which is the point.
    """
    __tablename__ = "pageviews"

    id = Column(Integer, primary_key=True)
    at = Column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    # "/results.html", "/certificate.html", "/" -- never a query string, which
    # is where personal data ends up by accident.
    path = Column(String(120), nullable=False, index=True)
    # SHA-256 of (a salt that changes every day + IP + user agent), truncated.
    # Same person, same day, same device = same value, so visitors can be
    # counted. Tomorrow it is a different value, so nobody can be followed
    # across days, and nothing here can be turned back into an address.
    visitor = Column(String(32), nullable=False, index=True)
    # Which race the visit was about, when the request says so. Page URLs carry
    # the code in the fragment, which browsers never send, so this is filled
    # from the API call the page makes next.
    event_code = Column(String(24), nullable=True, index=True)
    # Bare hostname only: "wa.me", "google.com". Never the full referring URL.
    referrer = Column(String(120), nullable=True)
    # phone | tablet | desktop, from a coarse user-agent check.
    device = Column(String(12), nullable=True)

    __table_args__ = (
        Index("ix_pageviews_at_path", "at", "path"),
    )


# --------------------------------------------------------------------------
# Signing up for a race, and what comes of it
# --------------------------------------------------------------------------

class Registration(Base):
    """Someone has asked to run. Not the same thing as being on the start list.

    A registration is a request; a Participant is a bib. Keeping them apart is
    what lets an organiser take entries for weeks, then decide the field, assign
    numbers, and print. Confirming a registration is what creates the entry.
    """
    __tablename__ = "registrations"

    id = Column(Integer, primary_key=True)
    event_id = Column(Integer, ForeignKey("events.id", ondelete="CASCADE"),
                      nullable=False, index=True)
    race_id = Column(Integer, ForeignKey("races.id", ondelete="SET NULL"), nullable=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"),
                     nullable=False, index=True)

    # pending -> confirmed (a bib exists) | withdrawn | rejected
    status = Column(String(12), nullable=False, default="pending")
    category = Column(String(60), nullable=True)
    gender = Column(String(16), nullable=True)
    # Not a medical record. A name and number to ring if someone does not come
    # back, which is the least a hill race should hold.
    emergency_contact = Column(String(160), nullable=True)
    note = Column(String(400), nullable=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    decided_at = Column(DateTime(timezone=True), nullable=True)

    event = relationship("Event")
    race = relationship("Race")
    user = relationship("User")

    __table_args__ = (
        # One entry per person per event. Changing your mind edits the row.
        UniqueConstraint("event_id", "user_id", name="uq_registration_person"),
    )


class Message(Base):
    """Something somebody sent through the contact form.

    Kept in the database first and emailed second. Mail needs credentials that
    may not be set, and a contact form that silently drops what people write
    because SMTP was misconfigured is worse than no contact form.
    """
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False,
                        index=True)
    name = Column(String(120), nullable=False)
    email = Column(String(190), nullable=False)
    subject = Column(String(160), nullable=False)
    body = Column(String(4000), nullable=False)
    # Set when a signed-in runner sent it, so a reply has somewhere to go.
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    # Whether the copy to the organiser's inbox actually left.
    emailed = Column(Boolean, nullable=False, default=False)
    handled = Column(Boolean, nullable=False, default=False)

    user = relationship("User")
