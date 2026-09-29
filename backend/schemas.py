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
    # cover = fill the 4:5 card and crop what does not fit; contain = fit the
    # whole image in, padded to the sides it does not reach.
    cert_fit: Optional[Literal["cover", "contain"]] = None


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
    cert_fit: Optional[str] = None
    # The scheduling fields, so race admin can show what it is editing. Without
    # these the "when and where" form loaded blank every time and quietly wiped
    # the values on save.
    starts_at: Optional[UtcDatetime] = None
    location: Optional[str] = None
    description: Optional[str] = None
    entry_note: Optional[str] = None
    is_published: bool = False
    registration_open: bool = False
    photo_url: Optional[str] = None
    photo_credit: Optional[str] = None
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


# --------------------------------------------------------------------------
# Operators
# --------------------------------------------------------------------------

class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    """What is safe to send about an account. No hash, ever.

    The contact details go out only to the account's owner (via /auth/me and
    /me/profile) and to a super admin managing members -- the two endpoints
    that serve this model. They are never part of a public payload.
    """
    id: int
    username: str
    display_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    home_town: Optional[str] = None
    bio: Optional[str] = None
    running_since: Optional[int] = None
    preferred_distances: Optional[str] = None
    strava_url: Optional[str] = None
    birth_year: Optional[int] = None
    visibility: str = "private"
    slug: Optional[str] = None
    avatar_url: Optional[str] = None
    announcements_opt_in: bool = False
    role: str
    is_active: bool
    must_change_password: bool
    created_at: Optional[UtcDatetime] = None
    last_login_at: Optional[UtcDatetime] = None

    class Config:
        from_attributes = True


class MeOut(BaseModel):
    """The signed-in user, plus what the UI is allowed to offer them.

    The permissions are sent so the interface can hide what will be refused.
    They are a convenience for the browser, never the check itself -- the
    server decides again on every request.
    """
    user: UserOut
    can_create_events: bool
    can_manage_users: bool


class UserIn(BaseModel):
    username: str = Field(min_length=2, max_length=40,
                          pattern=r"^[A-Za-z0-9._-]+$")
    password: str = Field(min_length=8, max_length=200)
    display_name: Optional[str] = Field(None, max_length=80)
    role: Literal["admin", "super_admin"] = "admin"


class UserPatch(BaseModel):
    display_name: Optional[str] = Field(None, max_length=80)
    role: Optional[Literal["admin", "super_admin"]] = None
    is_active: Optional[bool] = None
    # Set by a super admin resetting someone who is locked out.
    password: Optional[str] = Field(None, min_length=8, max_length=200)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


# --------------------------------------------------------------------------
# Runners
# --------------------------------------------------------------------------

class SignUpIn(BaseModel):
    """Opening an account as a runner. No role field -- that is not the
    signer-up's to choose, and accepting it from the body is how a public form
    becomes an admin account."""
    username: str = Field(min_length=2, max_length=40, pattern=r"^[A-Za-z0-9._-]+$")
    password: str = Field(min_length=8, max_length=200)
    display_name: str = Field(min_length=1, max_length=80)
    email: str = Field(min_length=3, max_length=190)
    phone: Optional[str] = Field(None, max_length=32)
    home_town: Optional[str] = Field(None, max_length=80)
    birth_year: Optional[int] = Field(None, ge=1900, le=2100)
    # Recorded, not assumed. The sign-up form cannot be submitted without it.
    consent: bool = False


class ProfileIn(BaseModel):
    display_name: Optional[str] = Field(None, max_length=80)
    email: Optional[str] = Field(None, max_length=190)
    phone: Optional[str] = Field(None, max_length=32)
    home_town: Optional[str] = Field(None, max_length=80)
    bio: Optional[str] = Field(None, max_length=600)
    running_since: Optional[int] = Field(None, ge=1950, le=2100)
    preferred_distances: Optional[str] = Field(None, max_length=120)
    strava_url: Optional[str] = Field(None, max_length=200)
    birth_year: Optional[int] = Field(None, ge=1900, le=2100)
    visibility: Optional[Literal["private", "members", "public"]] = None
    announcements_opt_in: Optional[bool] = None


class PublicProfileOut(BaseModel):
    """A runner as somebody else sees them.

    Deliberately absent: email, phone, emergency contact, exact birth year.
    Those exist for an organiser to reach somebody, not for the public.
    """
    slug: str
    display_name: str
    home_town: Optional[str] = None
    bio: Optional[str] = None
    running_since: Optional[int] = None
    preferred_distances: Optional[str] = None
    strava_url: Optional[str] = None
    avatar_url: Optional[str] = None
    visibility: str
    points: int = 0
    stats: dict = {}
    runs: List[dict] = []
    badges: List[dict] = []


class EventScheduleIn(BaseModel):
    """The parts of an event an entrant sees before race day."""
    starts_at: Optional[datetime] = None
    location: Optional[str] = Field(None, max_length=160)
    description: Optional[str] = Field(None, max_length=2000)
    entry_note: Optional[str] = Field(None, max_length=400)
    photo_credit: Optional[str] = Field(None, max_length=120)
    is_published: Optional[bool] = None
    registration_open: Optional[bool] = None


class EventPublicOut(BaseModel):
    """An event as the public sees it. No gun time, no branding internals."""
    code: str
    name: str
    starts_at: Optional[UtcDatetime] = None
    location: Optional[str] = None
    description: Optional[str] = None
    entry_note: Optional[str] = None
    registration_open: bool = False
    photo_url: Optional[str] = None
    photo_credit: Optional[str] = None
    races: List[RaceOut] = []
    entrants: int = 0
    # Filled in for a signed-in runner: their own registration, if any.
    my_status: Optional[str] = None

    class Config:
        from_attributes = True


class RegistrationIn(BaseModel):
    race_id: Optional[int] = None
    category: Optional[str] = Field(None, max_length=60)
    gender: Optional[str] = Field(None, max_length=16)
    emergency_contact: Optional[str] = Field(None, max_length=160)
    note: Optional[str] = Field(None, max_length=400)


class RegistrationOut(BaseModel):
    id: int
    event_code: str
    event_name: str
    race_id: Optional[int] = None
    race: Optional[str] = None
    status: str
    category: Optional[str] = None
    gender: Optional[str] = None
    emergency_contact: Optional[str] = None
    note: Optional[str] = None
    created_at: Optional[UtcDatetime] = None
    # Who it is, for the organiser's list.
    runner: Optional[str] = None
    username: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    bib: Optional[str] = None


class RegistrationDecision(BaseModel):
    status: Literal["pending", "confirmed", "withdrawn", "rejected"]
    # Required when confirming: a confirmed entry is a bib on a start list.
    bib: Optional[str] = Field(None, max_length=24)
    race_id: Optional[int] = None


class MessageIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=190)
    subject: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=4000)


class MessageOut(BaseModel):
    id: int
    created_at: Optional[UtcDatetime] = None
    name: str
    email: str
    subject: str
    body: str
    emailed: bool
    handled: bool
    username: Optional[str] = None

    class Config:
        from_attributes = True
