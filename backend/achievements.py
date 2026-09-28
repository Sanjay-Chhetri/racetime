"""A runner's own record: their races, their points, what they have earned.

All of it is derived, every time, from reads — the same rule the leaderboard
follows. Nothing here is stored, so voiding a bad scan or correcting a gun time
fixes someone's total without a migration or a recount job. A points table that
drifts out of step with the results it came from is worse than no points table.

The scheme is deliberately plain enough to explain at a finish line:

    finishing at all        10
    every kilometre          1
    first overall           25     second 15, third 10
    winning your category   10
    winning your gender      8

Podium points are only awarded where the placing means something — the same
rule the finisher card uses, so a field of four does not mint three champions.
"""
from typing import Optional

from sqlalchemy.orm import Session as DbSession

from .models import Event, Participant, Race
from .timing import event_result_rows

FINISH_POINTS = 10
PER_KM = 1
OVERALL = {1: 25, 2: 15, 3: 10}
CATEGORY_WIN = 10
GENDER_WIN = 8


def _earned(place: Optional[int], field: Optional[int], top: int = 3) -> bool:
    """A placing is worth something only in a field big enough to mean it.

    Third of four is not a podium. The finisher card uses the same test, so the
    badge on a card and the points in a total never disagree.
    """
    return bool(place and field and place <= top and place <= field / 2)


def score(row: dict, distance_km: float) -> tuple[int, list[str]]:
    """Points for one finish, and the reasons, so a total can be shown as a
    breakdown rather than a number the runner has to take on trust."""
    if row.get("status") != "finished":
        return 0, []

    points = FINISH_POINTS
    why = [f"Finished (+{FINISH_POINTS})"]

    km = int(distance_km or 0)
    if km:
        points += km * PER_KM
        why.append(f"{km} km (+{km * PER_KM})")

    place, field = row.get("position"), row.get("field_size")
    if _earned(place, field):
        points += OVERALL[place]
        why.append(f"{place} of {field} overall (+{OVERALL[place]})")

    if _earned(row.get("category_position"), row.get("category_size"), top=1):
        points += CATEGORY_WIN
        why.append(f"Won {row.get('category')} (+{CATEGORY_WIN})")

    if _earned(row.get("gender_position"), row.get("gender_size"), top=1):
        points += GENDER_WIN
        why.append(f"First {row.get('gender')} (+{GENDER_WIN})")

    return points, why


BADGES = [
    ("first-race", "First finish", "Finished a race.",
     lambda s: s["finishes"] >= 1),
    ("five-races", "Five races", "Finished five races.",
     lambda s: s["finishes"] >= 5),
    ("ten-races", "Ten races", "Finished ten races.",
     lambda s: s["finishes"] >= 10),
    ("podium", "Podium", "Finished in the top three.",
     lambda s: s["podiums"] >= 1),
    ("winner", "Race winner", "Won a race outright.",
     lambda s: s["wins"] >= 1),
    ("fifty-km", "Fifty kilometres", "Fifty kilometres of racing behind you.",
     lambda s: s["km"] >= 50),
    ("hundred-km", "Hundred kilometres", "A hundred kilometres of racing.",
     lambda s: s["km"] >= 100),
    ("hill-regular", "Hill regular", "Raced in three different events.",
     lambda s: s["events"] >= 3),
]


def profile(db: DbSession, user) -> dict:
    """Everything a runner's own page shows."""
    entries = (db.query(Participant)
               .filter(Participant.user_id == user.id)
               .all())
    if not entries:
        return _empty()

    # One results computation per event, not per entry: a runner with three
    # races in one event should cost one pass, not three.
    by_event: dict[int, list[Participant]] = {}
    for p in entries:
        by_event.setdefault(p.event_id, []).append(p)

    runs, total_points = [], 0
    stats = {"finishes": 0, "podiums": 0, "wins": 0, "km": 0.0, "events": 0}

    for event_id, mine in by_event.items():
        ev = db.get(Event, event_id)
        if ev is None:
            continue
        computed = {r["bib"]: r for r in event_result_rows(db, ev)}
        distances = {r.id: (r.distance_km or 0)
                     for r in db.query(Race).filter(Race.event_id == event_id)}
        counted_event = False

        for p in mine:
            row = computed.get(p.bib)
            if row is None:
                continue
            km = distances.get(p.race_id, 0)
            points, why = score(row, km)
            total_points += points

            if row["status"] == "finished":
                stats["finishes"] += 1
                stats["km"] += km
                if _earned(row.get("position"), row.get("field_size")):
                    stats["podiums"] += 1
                if row.get("position") == 1 and (row.get("field_size") or 0) >= 2:
                    stats["wins"] += 1
                if not counted_event:
                    stats["events"] += 1
                    counted_event = True

            runs.append({
                "event_code": ev.code,
                "event_name": ev.name,
                "date": ev.starts_at or ev.start_time,
                "race": row.get("race"),
                "distance_km": km,
                "bib": p.bib,
                "status": row["status"],
                "finish_seconds": row.get("finish_seconds"),
                "position": row.get("position"),
                "field_size": row.get("field_size"),
                "category": row.get("category"),
                "category_position": row.get("category_position"),
                "points": points,
                "points_why": why,
                # Only a finish has a certificate to collect.
                "certificate": (f"/certificate.html#{ev.code}/{p.bib}"
                                if row["status"] == "finished" else None),
            })

    runs.sort(key=lambda r: (r["date"] is None, r["date"]), reverse=True)

    best = None
    paced = [r for r in runs if r["status"] == "finished"
             and r["finish_seconds"] and r["distance_km"]]
    if paced:
        best = min(paced, key=lambda r: r["finish_seconds"] / r["distance_km"])

    return {
        "points": total_points,
        "runs": runs,
        "stats": {**stats, "km": round(stats["km"], 1)},
        "best_pace_run": best,
        "badges": [
            {"id": bid, "name": name, "detail": detail, "earned": test(stats)}
            for bid, name, detail, test in BADGES
        ],
        "scoring": {
            "finish": FINISH_POINTS, "per_km": PER_KM,
            "overall": OVERALL, "category_win": CATEGORY_WIN,
            "gender_win": GENDER_WIN,
        },
    }


def _empty() -> dict:
    stats = {"finishes": 0, "podiums": 0, "wins": 0, "km": 0.0, "events": 0}
    return {
        "points": 0, "runs": [], "stats": stats, "best_pace_run": None,
        "badges": [{"id": b, "name": n, "detail": d, "earned": False}
                   for b, n, d, _ in BADGES],
        "scoring": {"finish": FINISH_POINTS, "per_km": PER_KM,
                    "overall": OVERALL, "category_win": CATEGORY_WIN,
                    "gender_win": GENDER_WIN},
    }
