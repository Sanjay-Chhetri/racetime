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

    accent_color = Column(String(16), nullable=True)
    # Free text under the race name: "12 October 2026 · Siliguri".
    tagline = Column(String(160), nullable=True)
    # full | band. "full" runs the artwork across the whole bib; "band" keeps it
    # to a strip at the top so the number sits on bare paper. Which one is right
    # depends on the printer and the paper, so it stays an organiser's choice.
    bib_style = Column(String(8), nullable=True)

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
