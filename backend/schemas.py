from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class RaceIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    distance_km: float = 0.0
    sequence: int = 0
    start_time: Optional[datetime] = None


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
    start_time: Optional[datetime] = None


class BrandingIn(BaseModel):
    """Everything about an event that only affects how it looks in print."""
    accent_color: Optional[str] = Field(None, max_length=16)
    tagline: Optional[str] = Field(None, max_length=160)
    bib_style: Optional[Literal["full", "band"]] = None


class EventOut(BaseModel):
    id: int
    code: str
    name: str
    start_time: Optional[datetime]
    artwork_url: Optional[str] = None
    accent_color: Optional[str] = None
    tagline: Optional[str] = None
    bib_style: Optional[str] = None
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
    observed_at: datetime
    device_time: Optional[datetime] = None
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
    observed_at: datetime
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
    server_time: datetime
    epoch_ms: int
