"""Copy or merge a RaceTime database from one Postgres (or SQLite) to another.

    python tools/move_database.py --from "<old url>" --to "<new url>"
    python tools/move_database.py --from "<old url>" --to "<new url>" --merge
    python tools/move_database.py --from "<old url>" --to "<new url>" --accounts
    python tools/move_database.py --from "<old url>" --to "<new url>" --race kpg10k

Written for the day a free Neon project runs out of its monthly network
transfer allowance and the site has to move to a fresh one. The old data is not
lost -- it is unreachable until the allowance resets on the 1st -- so this
exists to bring it across afterwards.

What it does:

  * creates the schema in the destination if it is empty, by importing the app
  * copies every table in dependency order, so foreign keys always resolve
  * copies images as they are, in small batches, because they are the heavy
    rows and a single enormous transaction is how a copy dies at 90%
  * refuses to overwrite a destination that already has races in it, unless
    --merge (or --replace) is given

`--accounts` brings the people and nothing else: who can sign in, what they
are allowed to do, and the runners who have opened an account. No races, no
scans, no entries. It is the quickest way to make a fresh database usable by
the people who were already using the old one.

`--race <code>` brings one race and everything that belongs to it -- its
distances, checkpoints, start list, scans, entries and submitted runs -- plus
only the accounts those rows actually point at. Everything else in the source
is left where it is. That is how an old race is retrieved later without
dragging the rest of the history along with it.

Both imply `--merge`, since by then the destination is in use.

`--merge` is for the case this was really written for: the site had to move to
a fresh database in a hurry, people used it for a fortnight, and now the old
data has to come back **underneath** what they did. It:

  * shifts every incoming id by an offset past anything in the destination, so
    no two rows ever want the same id
  * treats a username that exists in both as **the same person**, mapping the
    old rows onto the account already there rather than making a second one
  * refuses, with a list, when a race code or workshop address exists in both
    -- renaming somebody's race code would break every printed bib and every
    link already handed out, so that one is a decision for a person
  * moves the Postgres sequences past the inserted rows afterwards, or the
    next sign-up would collide with the data just imported

It reads the source once. On a plan with a transfer allowance, that matters:
run it when you mean it rather than repeatedly.

Dry run first, always:

    python tools/move_database.py --from "..." --to "..." --dry-run
"""
import argparse
import os
import sys

# The order matters: a row is only inserted once the rows it points at exist.
TABLES = [
    "users",
    "events",
    "races",
    "checkpoints",
    "participants",
    "reads",
    "sessions",
    "registrations",
    "run_submissions",
    "event_operators",
    "workshops",
    "workshop_registrations",
    "interest_answers",
    "messages",
    "pageviews",
]

# Rows that are cheap to abandon. Sessions mean everybody signs in again, which
# is a smaller cost than copying them; page views are a counter, not a record.
SKIPPABLE = {"sessions", "pageviews"}


def columns_of(insp, table):
    return [c["name"] for c in insp.get_columns(table)]


def fk_map(insp, table):
    """{column: referred table} for this table, read from the schema itself."""
    out = {}
    for fk in insp.get_foreign_keys(table):
        for col in fk.get("constrained_columns", []):
            out[col] = fk.get("referred_table")
    return out


def connect(url):
    from sqlalchemy import create_engine
    if url.startswith("postgres://"):            # the legacy prefix Neon hands out
        url = url.replace("postgres://", "postgresql://", 1)
    return create_engine(url, pool_pre_ping=True)




def scope_to_race(src, code):
    """Everything that belongs to one race, and nothing that does not.

    Returns (tables in dependency order, {table: WHERE clause}, found).

    The accounts included are only those the race actually points at -- the
    people on the start list, the people who entered, and the admins running
    it. Somebody who never touched this race is not dragged along with it.
    """
    from sqlalchemy import text

    with src.connect() as sc:
        row = sc.execute(text("SELECT id FROM events WHERE code = :c"),
                         {"c": code}).first()
        if not row:
            return [], {}, False
        eid = int(row[0])

        # Entries first, because the submitted runs hang off them.
        regs = [r[0] for r in sc.execute(
            text("SELECT id FROM registrations WHERE event_id = :e"),
            {"e": eid}).all()]

        people = set()
        for sql in ("SELECT user_id FROM participants WHERE event_id = :e",
                    "SELECT user_id FROM registrations WHERE event_id = :e",
                    "SELECT user_id FROM event_operators WHERE event_id = :e"):
            try:
                people.update(r[0] for r in sc.execute(text(sql), {"e": eid}).all()
                              if r[0] is not None)
            except Exception:           # noqa: BLE001 - an older source may lack it
                pass

    in_regs = ("(" + ", ".join(str(int(r)) for r in regs) + ")") if regs else "(NULL)"
    in_people = ("(" + ", ".join(str(int(u)) for u in sorted(people)) + ")"
                 if people else "(NULL)")

    tables = ["users", "events", "races", "checkpoints", "participants",
              "reads", "registrations", "run_submissions", "event_operators"]
    where = {
        "users": f"id IN {in_people}",
        "events": f"id = {eid}",
        "races": f"event_id = {eid}",
        "checkpoints": f"event_id = {eid}",
        "participants": f"event_id = {eid}",
        "reads": f"event_id = {eid}",
        "registrations": f"event_id = {eid}",
        "run_submissions": f"registration_id IN {in_regs}",
        "event_operators": f"event_id = {eid}",
    }
    return tables, where, True

def plan_merge(src, dst, s_insp, d_insp, wanted=None, where=None):
    """Work out the id offset, which accounts already exist, and what clashes.

    Only what is actually being copied can clash. Moving one race must not be
    stopped by a different race that happens to exist in both databases, and
    taking the accounts alone cannot clash on a race code at all.

    Returns (offset, {old user id: existing id}, [blocking conflicts]).
    """
    wanted = TABLES if wanted is None else wanted
    where = where or {}
    from sqlalchemy import text

    # An offset past every id in the destination, rounded up so the number is
    # readable in a database somebody may have to look at by hand later.
    high = 0
    with dst.connect() as dc:
        for table in TABLES:
            if not d_insp.has_table(table):
                continue
            if "id" not in columns_of(d_insp, table):
                continue
            got = dc.execute(text(f"SELECT MAX(id) FROM {table}")).scalar() or 0
            high = max(high, int(got))
    offset = ((high // 100000) + 1) * 100000

    # A username in both databases is one person, not two.
    user_map, blocked = {}, []
    with dst.connect() as dc, src.connect() as sc:
        theirs = {u: i for u, i in
                  dc.execute(text("SELECT username, id FROM users")).all()}
        for uid, uname, email, slug in sc.execute(text(
                "SELECT id, username, email, slug FROM users")).all():
            if uname in theirs:
                user_map[uid] = theirs[uname]

        # These two cannot be guessed at: a race code is printed on bibs and
        # sits in every link already shared.
        for label, table, col in (("race code", "events", "code"),
                                  ("workshop", "workshops", "slug")):
            if table not in wanted:
                continue                    # not being copied, cannot clash
            if not (s_insp.has_table(table) and d_insp.has_table(table)):
                continue
            clause = (" WHERE " + where[table]) if where.get(table) else ""
            mine = {r[0] for r in
                    sc.execute(text(f"SELECT {col} FROM {table}{clause}")).all()}
            yours = {r[0] for r in dc.execute(text(f"SELECT {col} FROM {table}")).all()}
            for clash in sorted(mine & yours):
                blocked.append(f"{label}: {clash!r}")

        # An address or a web name shared by two different people is rarer and
        # just as undecidable.
        only = (" AND " + where["users"]) if where.get("users") else ""
        mine = {e: i for i, e in sc.execute(text(
            f"SELECT id, email FROM users WHERE email IS NOT NULL{only}")).all()}
        yours = {e: i for i, e in dc.execute(text(
            "SELECT id, email FROM users WHERE email IS NOT NULL")).all()}
        for email in sorted(set(mine) & set(yours)):
            if user_map.get(mine[email]) != yours[email]:
                blocked.append(f"email on two different accounts: {email!r}")

    return offset, user_map, blocked


def shift(row, table, offset, user_map, fks):
    """Move one row out of the old database's numbering and into the new one."""
    out = dict(row)

    # Its own id, unless the key is a string the device generated (a read).
    if "id" in out and isinstance(out.get("id"), int):
        out["id"] = out["id"] + offset

    for col, referred in fks.items():
        value = out.get(col)
        if value is None or not isinstance(value, int):
            continue
        if referred == "users":
            # The same person, if they already have an account over here.
            out[col] = user_map.get(value, value + offset)
        else:
            out[col] = value + offset

    # A row for somebody who already exists is not inserted again.
    if table == "users" and row.get("id") in user_map:
        return None
    return out


def bump_sequences(dst, d_insp):
    """Move Postgres id sequences past what was just inserted.

    Without this the next sign-up asks for id 5 and finds the imported row
    already sitting there. SQLite has no sequences and needs nothing.
    """
    from sqlalchemy import text
    if dst.dialect.name != "postgresql":
        return
    moved = 0
    with dst.begin() as dc:
        for table in TABLES:
            if not d_insp.has_table(table) or "id" not in columns_of(d_insp, table):
                continue
            try:
                dc.execute(text(
                    f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                    f"COALESCE((SELECT MAX(id) FROM {table}), 1))"))
                moved += 1
            except Exception as e:                  # noqa: BLE001
                print(f"  could not move the {table} sequence: {e}")
    print(f"  moved {moved} id sequence(s) past the imported rows")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src", required=True, help="source DATABASE_URL")
    ap.add_argument("--to", dest="dst", required=True, help="destination DATABASE_URL")
    ap.add_argument("--batch", type=int, default=200,
                    help="rows per insert; lower it if a table has big images")
    ap.add_argument("--dry-run", action="store_true",
                    help="count what would move, write nothing")
    ap.add_argument("--replace", action="store_true",
                    help="allow writing into a destination that already has races")
    ap.add_argument("--skip-sessions", action="store_true", default=True,
                    help="do not copy sign-in sessions or page views (default)")
    ap.add_argument("--merge", action="store_true",
                    help="add this data to a destination already in use, "
                         "shifting ids so nothing collides")
    ap.add_argument("--accounts", action="store_true",
                    help="only the accounts: who signs in and what they may do")
    ap.add_argument("--race", metavar="CODE",
                    help="only this race and what belongs to it")
    args = ap.parse_args()

    from sqlalchemy import inspect, text

    if args.accounts and args.race:
        print("Choose one of --accounts and --race, not both.")
        return 1
    # Both are additions to a database somebody is already using.
    if args.accounts or args.race:
        args.merge = True

    src = connect(args.src)
    dst = connect(args.dst)

    # The destination gets its schema from the app itself, so there is one
    # definition of the schema and this never drifts from it.
    print("Creating the schema in the destination (if it is not there)...")
    os.environ["DATABASE_URL"] = args.dst
    os.environ["RACETIME_NO_DEMO"] = "1"        # no practice race here
    # And no accounts: seeded users take ids 1-4, which are the ids the real
    # rows arrive with.
    os.environ["RACETIME_SEED_USERS"] = "none"
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import backend.main  # noqa: F401  (importing it builds and migrates the schema)

    s_insp, d_insp = inspect(src), inspect(dst)
    moved = skipped = 0

    with dst.connect() as check:
        existing = check.execute(text("SELECT COUNT(*) FROM events")).scalar() or 0

    # What to take. Worked out before the merge is planned, because what
    # counts as a clash depends on what is actually being copied: moving one
    # race must not be stopped by a different race that exists in both.
    wanted, where = TABLES, {}
    if args.accounts:
        wanted = ["users"]
        print("Taking the accounts only: no races, scans or entries.\n")
    elif args.race:
        wanted, where, found = scope_to_race(src, args.race)
        if not found:
            print(f"There is no race with the code {args.race!r} in the source.")
            return 1
        print(f"Taking the race {args.race!r} and only what belongs to it.\n")

    # ---- merging into a database somebody has been using ------------------
    offset, user_map = 0, {}
    if args.merge:
        offset, user_map, blocked = plan_merge(src, dst, s_insp, d_insp,
                                               wanted, where)
        if blocked:
            print("\nThese exist in both databases, and only you can say which "
                  "should win:\n")
            for line in blocked:
                print("   " + line)
            print("\nRename one side, then run this again. Nothing was written.")
            return 1
        print(f"\nMerging: incoming ids shift by +{offset}; "
              f"{len(user_map)} account(s) already exist and will be reused.\n")

    if existing and not args.replace and not args.merge and not args.dry_run:
        print(f"\nThe destination already has {existing} event(s). Nothing was "
              f"written.\nUse --merge to add this data to it, keeping both.")
        return 1

    for table in wanted:
        if args.merge and table == "users" and user_map:
            pass            # handled row by row below
        if table in SKIPPABLE and args.skip_sessions:
            print(f"  {table:<24} skipped (everybody signs in again)")
            continue
        if not s_insp.has_table(table):
            print(f"  {table:<24} not in the source")
            continue
        if not d_insp.has_table(table):
            print(f"  {table:<24} NOT IN THE DESTINATION -- schema mismatch")
            continue

        # Only the columns both ends share, so a source built by an older
        # version of the app still copies.
        cols = ([c["name"] for c in s_insp.get_columns(table)]
                if s_insp.has_table(table) else [])
        dcols = {c["name"] for c in d_insp.get_columns(table)}
        cols = [c for c in cols if c in dcols]
        if not cols:
            continue

        clause = (" WHERE " + where[table]) if where.get(table) else ""
        with src.connect() as sc:
            total = sc.execute(
                text(f"SELECT COUNT(*) FROM {table}{clause}")).scalar() or 0
            if not total:
                print(f"  {table:<24} empty")
                continue
            if args.dry_run:
                print(f"  {table:<24} would copy {total} row(s)")
                moved += total
                continue

            fks = fk_map(s_insp, table)
            quoted = ", ".join(f'"{c}"' for c in cols)
            placeholders = ", ".join(f":{c}" for c in cols)
            insert = text(f'INSERT INTO {table} ({quoted}) VALUES ({placeholders})')
            done = 0
            result = sc.execution_options(stream_results=True, yield_per=args.batch) \
                .execute(text(f"SELECT {quoted} FROM {table}{clause}"))
            while True:
                chunk = result.fetchmany(args.batch)
                if not chunk:
                    break
                rows = [dict(zip(cols, r)) for r in chunk]
                if args.merge:
                    rows = [shift(row, table, offset, user_map, fks)
                            for row in rows]
                    rows = [r for r in rows if r is not None]
                if rows:
                    with dst.begin() as dc:
                        dc.execute(insert, rows)
                done += len(rows)
                print(f"  {table:<24} {done}/{total}", end="\r")
            print(f"  {table:<24} {done} row(s) copied        ")
            moved += done

    if args.merge and not args.dry_run:
        bump_sequences(dst, d_insp)

    print(f"\n{'Would copy' if args.dry_run else 'Copied'} {moved} row(s).")
    if not args.dry_run:
        print("\nNow point DATABASE_URL at the destination and redeploy.")
        print("Everybody is signed out, so sign in again to check it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
