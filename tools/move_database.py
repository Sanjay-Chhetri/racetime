"""Copy a RaceTime database from one Postgres (or SQLite) to another.

    python tools/move_database.py --from "<old url>" --to "<new url>"

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
    --replace is given

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


def connect(url):
    from sqlalchemy import create_engine
    if url.startswith("postgres://"):            # the legacy prefix Neon hands out
        url = url.replace("postgres://", "postgresql://", 1)
    return create_engine(url, pool_pre_ping=True)


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
    args = ap.parse_args()

    from sqlalchemy import inspect, text

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
    if existing and not args.replace and not args.dry_run:
        print(f"\nThe destination already has {existing} event(s). Nothing was "
              f"written.\nRe-run with --replace if you really mean to add to it.")
        return 1

    for table in TABLES:
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

        with src.connect() as sc:
            total = sc.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar() or 0
            if not total:
                print(f"  {table:<24} empty")
                continue
            if args.dry_run:
                print(f"  {table:<24} would copy {total} row(s)")
                moved += total
                continue

            quoted = ", ".join(f'"{c}"' for c in cols)
            placeholders = ", ".join(f":{c}" for c in cols)
            insert = text(f'INSERT INTO {table} ({quoted}) VALUES ({placeholders})')
            done = 0
            result = sc.execution_options(stream_results=True, yield_per=args.batch) \
                .execute(text(f"SELECT {quoted} FROM {table}"))
            while True:
                chunk = result.fetchmany(args.batch)
                if not chunk:
                    break
                rows = [dict(zip(cols, r)) for r in chunk]
                with dst.begin() as dc:
                    dc.execute(insert, rows)
                done += len(rows)
                print(f"  {table:<24} {done}/{total}", end="\r")
            print(f"  {table:<24} {done} row(s) copied        ")
            moved += done

    print(f"\n{'Would copy' if args.dry_run else 'Copied'} {moved} row(s).")
    if not args.dry_run:
        print("\nNow point DATABASE_URL at the destination and redeploy.")
        print("Everybody is signed out, so sign in again to check it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
