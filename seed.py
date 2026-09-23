"""Load a demo race so you can see the whole thing working immediately.

    python seed.py

Creates a 10 km race with a 5 km and 9 km split, 40 runners, and a plausible
set of reads -- including a couple of deliberate messes (a double scan, a phone
with a drifting clock, a runner who never reaches the finish) so you can watch
how the reconciliation handles them.
"""
import random
import uuid
from datetime import datetime, timedelta, timezone

from backend.db import Base, SessionLocal, engine
from backend.models import Checkpoint, Event, Participant, Read

CODE = "siliguri10k"

NAMES = [
    "Tenzing Bhutia", "Anita Rai", "Prakash Chettri", "Dolma Sherpa", "Rohit Thapa",
    "Sunita Limbu", "Karma Lepcha", "Bikash Subba", "Mingma Tamang", "Reshma Gurung",
    "Arjun Pradhan", "Nima Doma", "Suraj Mukhia", "Pemba Tshering", "Kavita Newar",
    "Deepak Rai", "Yangchen Bhutia", "Sanjeev Sharma", "Anjali Chhetri", "Dawa Sherpa",
]

random.seed(7)


def main():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    if db.query(Event).filter(Event.code == CODE).first():
        print(f"Event '{CODE}' already exists. Delete racetime.db to reseed.")
        return

    start = datetime.now(timezone.utc) - timedelta(minutes=75)
    ev = Event(code=CODE, name="Siliguri Hill Run 10K", start_time=start)
    db.add(ev)
    db.flush()

    cps = [
        Checkpoint(event_id=ev.id, name="5 km bridge", distance_km=5, sequence=1, kind="split"),
        Checkpoint(event_id=ev.id, name="9 km turn", distance_km=9, sequence=2, kind="split"),
        Checkpoint(event_id=ev.id, name="Finish", distance_km=10, sequence=3, kind="finish"),
    ]
    db.add_all(cps)
    db.flush()

    runners = []
    for i in range(1, 41):
        name = NAMES[(i - 1) % len(NAMES)] if i <= 20 else f"Runner {i}"
        runners.append(Participant(
            event_id=ev.id, bib=str(i), name=name,
            category=random.choice(["Open", "Women", "Veteran"]),
        ))
    db.add_all(runners)
    db.flush()

    reads = []

    def add(bib, cp, when, source="qr", offset=0, device="phone-a"):
        reads.append(Read(
            read_id=str(uuid.uuid4()), event_id=ev.id, checkpoint_id=cp.id,
            bib=str(bib), observed_at=when, device_time=when - timedelta(milliseconds=offset),
            clock_offset_ms=offset, source=source, device_id=device,
        ))

    for r in runners:
        # Roughly 5:00-7:30 per km, with the usual slow drift over the race.
        pace = random.uniform(300, 450)
        n = int(r.bib)

        t5 = start + timedelta(seconds=pace * 5 * random.uniform(.97, 1.02))
        add(r.bib, cps[0], t5, device="phone-a")

        # Runners 33 and 37 drop out after 5 km.
        if n in (33, 37):
            continue

        # The 9 km phone's clock is 6 seconds fast. The app corrected it at
        # setup, so observed_at is right and the drift is only visible in the
        # audit column -- which is exactly the point.
        t9 = t5 + timedelta(seconds=pace * 4 * random.uniform(1.0, 1.08))
        add(r.bib, cps[1], t9, offset=-6000, device="phone-b")

        tf = t9 + timedelta(seconds=pace * random.uniform(.9, 1.05))
        add(r.bib, cps[2], tf, device="phone-c")

        # Bib 12 gets scanned twice at the finish, a second apart. Timing takes
        # the earlier one and the duplicate changes nothing.
        if n == 12:
            add(r.bib, cps[2], tf + timedelta(seconds=1.4), device="phone-c")

    # A bib nobody registered, typed in by a volunteer. Stored, flagged, and
    # left for the race director to sort out.
    add("404", cps[1], start + timedelta(minutes=48), source="manual", device="phone-b")

    db.add_all(reads)
    for r in runners:
        if r.bib in ("33", "37"):
            r.dnf = True
    db.commit()

    print(f"Seeded '{ev.name}' with {len(runners)} runners and {len(reads)} reads.")
    print(f"  Admin:   http://localhost:8000/admin.html#{CODE}")
    print(f"  Results: http://localhost:8000/results.html#{CODE}")


if __name__ == "__main__":
    main()
