"""Turn raw reads into splits and a ranked result list.

Nothing here writes to the database. Results are always recomputed, which is
what lets you void a bad read or fix a clock offset and immediately get a
corrected leaderboard without any migration or repair job.

Rule for picking a time when a bib was seen several times at one checkpoint:
take the earliest non-voided read. A volunteer scanning the same runner twice,
or an RFID mat catching a tag on three consecutive antenna cycles, both collapse
to the moment the runner actually arrived.
"""
from datetime import timezone
from typing import Dict, List, Optional

from .models import Checkpoint, Event, Participant, Read


def _aware(dt):
    """SQLite hands back naive datetimes. Treat those as UTC."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def format_duration(seconds: Optional[float]) -> Optional[str]:
    if seconds is None:
        return None
    seconds = max(0, int(round(seconds)))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}"


def format_pace(seconds: float, km: float) -> Optional[str]:
    if not km or km <= 0 or seconds <= 0:
        return None
    per_km = seconds / km
    m, s = divmod(int(round(per_km)), 60)
    return f"{m}:{s:02d}/km"


def _rank_within(rows: List[dict], key, field: str, size_field: str) -> None:
    """Rank finishers inside each group produced by `key`.

    Used for overall, category and gender placings. A runner with no grouping
    value -- no category recorded, say -- gets no placing rather than being
    lumped into a bogus "None" division.
    """
    groups: Dict[object, List[dict]] = {}
    for r in rows:
        if r["status"] != "finished":
            continue
        k = key(r)
        if k is None:
            continue
        groups.setdefault(k, []).append(r)
    for members in groups.values():
        members.sort(key=lambda r: r["finish_seconds"])
        for i, r in enumerate(members, start=1):
            r[field] = i
            r[size_field] = len(members)


def compute_results(
    event: Event,
    checkpoints: List[Checkpoint],
    participants: List[Participant],
    reads: List[Read],
    race=None,
) -> List[dict]:
    """Results for one field of runners.

    Called once per race. `race` supplies the gun time when it has its own --
    that is what makes a staggered start work, where the 5K goes off after the
    10K and both are timed from their own start.
    """
    cp_by_id: Dict[int, Checkpoint] = {c.id: c for c in checkpoints}
    start_cp_ids = {c.id for c in checkpoints if c.kind == "start"}
    finish_cp_ids = {c.id for c in checkpoints if c.kind == "finish"}

    # bib -> checkpoint_id -> earliest observed_at
    earliest: Dict[str, Dict[int, object]] = {}
    for r in reads:
        if r.voided or r.checkpoint_id not in cp_by_id:
            continue
        seen = earliest.setdefault(r.bib, {})
        at = _aware(r.observed_at)
        if r.checkpoint_id not in seen or at < seen[r.checkpoint_id]:
            seen[r.checkpoint_id] = at

    # A race with its own gun overrides the event's; an individual start read
    # still beats both.
    gun = _aware(getattr(race, "start_time", None)) or _aware(event.start_time)
    ordered_cps = sorted(checkpoints, key=lambda c: (c.sequence, c.distance_km))

    rows = []
    for p in participants:
        seen = earliest.get(p.bib, {})

        # An individual start read beats the gun time. This is the hook for
        # wave starts: nothing else in the pipeline needs to know about waves.
        start_at = gun
        for cid in start_cp_ids:
            if cid in seen:
                start_at = seen[cid]
                break

        splits = []
        last_at = None
        finish_seconds = None

        for cp in ordered_cps:
            if cp.kind == "start" or cp.id not in seen:
                continue
            at = seen[cp.id]
            last_at = at if last_at is None or at > last_at else last_at
            elapsed = (at - start_at).total_seconds() if start_at else None
            if elapsed is None:
                continue
            splits.append({
                "checkpoint_id": cp.id,
                "checkpoint": cp.name,
                "distance_km": cp.distance_km,
                "observed_at": at,
                "elapsed_seconds": elapsed,
                "pace_per_km": format_pace(elapsed, cp.distance_km),
            })
            if cp.id in finish_cp_ids:
                finish_seconds = elapsed

        if p.dnf:
            status = "dnf"
        elif finish_seconds is not None:
            status = "finished"
        elif splits:
            status = "on_course"
        else:
            status = "not_started"

        rows.append({
            "bib": p.bib,
            "name": p.name,
            "category": p.category,
            "gender": p.gender,
            "race_id": getattr(race, "id", None),
            "race": getattr(race, "name", None),
            "status": status,
            "position": None,
            "category_position": None,
            "category_size": None,
            "gender_position": None,
            "gender_size": None,
            "field_size": None,
            "finish_seconds": finish_seconds,
            "finish_time": format_duration(finish_seconds),
            "last_seen": last_at.isoformat() if last_at else None,
            "splits": splits,
        })

    # Overall placing is within this race only -- a 5K runner is never ranked
    # against the 10K field.
    _rank_within(rows, lambda r: "overall", "position", "field_size")
    _rank_within(rows, lambda r: r["category"], "category_position", "category_size")
    _rank_within(rows, lambda r: r["gender"], "gender_position", "gender_size")

    order = {"finished": 0, "on_course": 1, "dnf": 2, "not_started": 3}
    rows.sort(key=lambda r: (
        order[r["status"]],
        r["position"] if r["position"] is not None else 0,
        -len(r["splits"]),
        r["bib"],
    ))
    return rows


def event_result_rows(db, event) -> List[dict]:
    """Every runner in an event, ranked inside their own race.

    Extracted so the results endpoint and a runner's own record cannot drift
    apart: two copies of "how an event is scored" would eventually disagree,
    and the one nobody is looking at would be the wrong one.
    """
    reads = db.query(Read).filter(Read.event_id == event.id).all()

    rows: List[dict] = []
    for race in event.races:
        rows.extend(compute_results(
            event, race.checkpoints, race.participants, reads, race=race))

    # Anyone still unassigned -- possible only if a race was deleted out from
    # under them -- is timed against the event's own checkpoints so they never
    # silently vanish.
    loose = [p for p in event.participants if p.race_id is None]
    if loose:
        rows.extend(compute_results(
            event, [c for c in event.checkpoints if c.race_id is None],
            loose, reads))
    return rows
