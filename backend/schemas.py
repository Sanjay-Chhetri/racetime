from datetime import datetime, timezone
from typing import Annotated, List, Literal, Optional

from pydantic import AfterValidator, BaseModel, Field


def as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Force a datetime to be UTC-aware.

    SQLite does not persist tzinfo even when the column says
    DateTime(timezone=True), so values read back are naive. Everything this app
    stores is UTC, so a naive value *is* UTC and simply needs saying so.

    This matters because a bare "2026-09-06T06:41:58" has no offset, and
    JavaScript's `new Date()` parses that as **local** time -- which showed IST
    users a gun time five and a half hours out. Normalising here fixes it for
    every consumer at once, rather than patching each page.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# Use in place of `datetime` on anything that leaves the API.
UtcDatetime = Annotated[datetime, AfterValidator(as_utc)]


class RaceIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    distance_km: float = 0.0
    sequence: int = 0
    start_time: Optional[UtcDatetime] = None


class RaceOut(RaceIn):
    id: int

    class Config:
        from_attributes = True


class CheckpointIn(BaseModel):
    name: str
    distance_km: float = 0.0
    sequence: int = 0
    kind: str = "split"  # start | split | finish
    race_id: Optional[int] = None


class CheckpointOut(CheckpointIn):
    id: int

    class Config:
        from_attributes = True


class CheckpointUpdate(BaseModel):
    """Every field optional, so a caller can move one checkpoint's sequence
    without restating the rest of it."""
    name: Optional[str] = None
    distance_km: Optional[float] = None
    sequence: Optional[int] = None
    kind: Optional[Literal["start", "split", "finish"]] = None
    race_id: Optional[int] = None


class ParticipantIn(BaseModel):
    bib: str
    name: str
    category: Optional[str] = None
    gender: Optional[str] = None
    race_id: Optional[int] = None


class ParticipantOut(ParticipantIn):
    id: int
    dnf: bool = False

    class Config:
        from_attributes = True


class EventIn(BaseModel):
    code: str = Field(..., min_length=2, max_length=24)
    name: str
    start_time: Optional[UtcDatetime] = None


class BrandingIn(BaseModel):
    """Everything about an event that only affects how it looks in print."""
    accent_color: Optional[str] = Field(None, max_length=16)
    tagline: Optional[str] = Field(None, max_length=160)
    bib_style: Optional[Literal["full", "band"]] = None
    # placing = show a rank only when it is an achievement; text = show the same
    # word to everyone, which is what a school walk wants; none = show nothing.
    badge_mode: Optional[Literal["placing", "text", "none"]] = None
    badge_text: Optional[str] = Field(None, max_length=40)


class EventOut(BaseModel):
    id: int
    code: str
    name: str
    start_time: Optional[UtcDatetime]
    artwork_url: Optional[str] = None
    accent_color: Optional[str] = None
    tagline: Optional[str] = None
    bib_style: Optional[str] = None
    cert_artwork_url: Optional[str] = None
    badge_mode: Optional[str] = None
    badge_text: Optional[str] = None
    races: List[RaceOut] = []
    checkpoints: List[CheckpointOut] = []

    class Config:
        from_attributes = True


class ReadIn(BaseModel):
    """A single sighting, as posted by a capture device.

    read_id is generated on the device. Do not generate it here -- that would
    break idempotency, because a retried batch would arrive with fresh ids and
    be stored twice.
    """
    read_id: str
    checkpoint_id: int
    bib: str
    observed_at: UtcDatetime
    device_time: Optional[UtcDatetime] = None
    clock_offset_ms: int = 0
    source: str = "qr"
    device_id: Optional[str] = None


class ReadBatchIn(BaseModel):
    reads: List[ReadIn]


class ReadBatchOut(BaseModel):
    accepted: int
    duplicates: int
    rejected: List[dict] = []


class SplitOut(BaseModel):
    checkpoint_id: int
    checkpoint: str
    distance_km: float
    observed_at: UtcDatetime
    elapsed_seconds: float
    pace_per_km: Optional[str] = None


class ResultOut(BaseModel):
    bib: str
    name: str
    category: Optional[str]
    status: str  # finished | on_course | not_started | dnf
    position: Optional[int]
    finish_seconds: Optional[float]
    finish_time: Optional[str]
    last_seen: Optional[str]
    splits: List[SplitOut] = []


class TimeOut(BaseModel):
    server_time: UtcDatetime
    epoch_ms: int
