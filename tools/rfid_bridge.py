"""Bridge a UHF RFID timing mat into RaceTime.

This is the upgrade path in one file. When you eventually rent proper timing
mats, you run this on a laptop next to the reader. It posts to exactly the same
endpoint the phones use, so nothing in the backend, the results page or the
timing logic changes -- the only difference in the database is source='rfid'.

Most timing readers (Impinj, Zebra, ThingMagic) speak LLRP over the network.
The `sllurp` library talks LLRP:

    pip install sllurp
    python tools/rfid_bridge.py --reader 192.168.1.50 \
        --event siliguri10k --checkpoint 3 --api http://localhost:8000

Run it with --simulate to try the whole pipeline with no hardware at all.

Two details that matter in practice:

1. A tag under an antenna is read dozens of times per second. The first read is
   the one closest to the moment the runner crossed, so we keep the first and
   suppress the rest for a few seconds.

2. Tag EPCs are not bib numbers. Timing suppliers give you a mapping file. Pass
   it with --map as a CSV of `epc,bib`. Without one, the EPC is used as the bib,
   which is fine for testing.
"""
import argparse
import csv
import time
import uuid
from datetime import datetime, timezone

import urllib.request
import json

REPEAT_WINDOW_S = 6.0


def post_reads(api, event, reads):
    body = json.dumps({"reads": reads}).encode()
    req = urllib.request.Request(
        f"{api}/api/events/{event}/reads",
        data=body, headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as res:
        return json.load(res)


def make_read(bib, checkpoint_id, when=None):
    return {
        "read_id": str(uuid.uuid4()),
        "checkpoint_id": checkpoint_id,
        "bib": str(bib),
        "observed_at": (when or datetime.now(timezone.utc)).isoformat(),
        "source": "rfid",
        "device_id": "mat-bridge",
        "clock_offset_ms": 0,
    }


def load_map(path):
    if not path:
        return {}
    with open(path, newline="", encoding="utf-8") as f:
        return {r[0].strip().upper(): r[1].strip() for r in csv.reader(f) if len(r) >= 2}


def run(args):
    epc_to_bib = load_map(args.map)
    last_seen = {}
    pending = []

    def sighting(epc):
        bib = epc_to_bib.get(epc.upper(), epc)
        now = time.time()
        if now - last_seen.get(bib, 0) < REPEAT_WINDOW_S:
            return
        last_seen[bib] = now
        pending.append(make_read(bib, args.checkpoint))
        print(f"  {bib}  {datetime.now().strftime('%H:%M:%S')}")

    def drain():
        if not pending:
            return
        try:
            out = post_reads(args.api, args.event, pending)
            print(f"  -> sent {out['accepted']}, duplicates {out['duplicates']}")
            pending.clear()
        except Exception as e:
            # Keep them queued. Same principle as the phones: never drop a read
            # because the network blinked.
            print(f"  !! send failed ({e}); {len(pending)} still queued")

    if args.simulate:
        print("Simulating a mat. Ctrl-C to stop.")
        import random
        bibs = [str(i) for i in range(1, 41)]
        random.shuffle(bibs)
        for bib in bibs:
            sighting(bib)
            drain()
            time.sleep(args.interval)
        return

    from sllurp.llrp import LLRPReaderClient, LLRPReaderConfig, LLRP_DEFAULT_PORT

    def on_tags(reader, tags):
        for tag in tags:
            epc = tag.get("EPC-96") or tag.get("EPC")
            if isinstance(epc, bytes):
                epc = epc.decode(errors="ignore")
            if epc:
                sighting(epc)
        drain()

    config = LLRPReaderConfig({
        "report_every_n_tags": 1,
        "antennas": [int(a) for a in args.antennas.split(",")],
        "start_inventory": True,
        "tx_power": 0,
    })
    client = LLRPReaderClient(args.reader, LLRP_DEFAULT_PORT, config)
    client.add_tag_report_callback(on_tags)
    client.connect()
    print(f"Connected to {args.reader}. Reading. Ctrl-C to stop.")
    try:
        while True:
            time.sleep(1)
            drain()
    except KeyboardInterrupt:
        client.disconnect()
        drain()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--event", required=True, help="event code")
    ap.add_argument("--checkpoint", type=int, required=True, help="checkpoint id")
    ap.add_argument("--reader", help="reader IP address")
    ap.add_argument("--antennas", default="1,2")
    ap.add_argument("--map", help="CSV of epc,bib")
    ap.add_argument("--simulate", action="store_true", help="fake a mat, no hardware")
    ap.add_argument("--interval", type=float, default=1.0)
    run(ap.parse_args())
