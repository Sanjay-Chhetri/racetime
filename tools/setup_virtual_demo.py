"""Put a test virtual race on a running RaceTime, ready to walk through.

    python tools/setup_virtual_demo.py                 # the live site
    python tools/setup_virtual_demo.py http://127.0.0.1:8000

It asks for your own operator password at the prompt. Nothing is stored and
nothing is printed: it goes straight into the login call and is forgotten.
`RACETIME_USER`, `RACETIME_PASSWORD` and `RACETIME_UPI` skip the prompts when
something else is driving this.

Idempotent. Run it twice and you get the same single race, brought back to
these settings, rather than a second one.

What it makes:

  * a published virtual race, `vdemo`, open from yesterday for thirty days
  * two distances, 10K and 25K, priced at a rupee or two -- small enough to
    pay for real, which is the only way to find out whether paying works
  * your UPI id, if you give it, so the pay button has somewhere to point

Delete it from race admin when you are done with it.
"""
import getpass
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

# A Windows console is often still cp1252, which cannot encode a rupee sign,
# and a tool that dies printing a price it just set is a tool that lies about
# having failed. Replacement characters are better than a traceback.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):       # a pipe or a very old Python
    pass

BASE = (sys.argv[1] if len(sys.argv) > 1
        else "https://racetime-beta.vercel.app").rstrip("/")
CODE = "vdemo"
NAME = "Pedong Virtual Challenge (test)"


class Api:
    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor())

    def call(self, method, path, data=None):
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(self.base + "/api" + path, data=body,
                                     method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.op.open(req, timeout=60) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw or b"{}")
            except ValueError:
                return e.code, {"detail": raw[:200].decode("utf-8", "replace")}
        except urllib.error.URLError as e:
            print(f"Could not reach {self.base}: {e.reason}")
            raise SystemExit(1)


def main():
    print(f"Setting up a test virtual race on {BASE}\n")
    api = Api(BASE)

    # The prompt is the normal way in. The environment variables exist so this
    # can run unattended -- and so it can be tested at all, since getpass
    # reads the terminal directly and ignores a pipe.
    user = (os.getenv("RACETIME_USER")
            or input("Your operator username [sanjay]: ").strip() or "sanjay")
    pw = os.getenv("RACETIME_PASSWORD") or getpass.getpass(
        "Your password (not shown, not stored): ")
    st, body = api.call("POST", "/auth/login", {"username": user, "password": pw})
    if st != 200:
        print(f"  Could not sign in: {body.get('detail', st)}")
        raise SystemExit(1)
    me = body.get("user", {})
    if not body.get("can_create_events"):
        print(f"  {user} is an {me.get('role')}, and creating a race needs a "
              f"super admin. Ask one of them, or run this as sanjay or sajal.")
        raise SystemExit(1)
    print(f"  signed in as {me.get('display_name') or user} ({me.get('role')})")

    scripted = os.getenv("RACETIME_UPI") is not None
    upi = (os.getenv("RACETIME_UPI") if scripted
           else input("\nYour UPI id, for the pay button (blank to skip): ")).strip()
    upi_name = ""
    if upi:
        asked = "" if scripted else input(
            "The name it should show [Kalimpong Runners]: ").strip()
        upi_name = (os.getenv("RACETIME_UPI_NAME") or asked
                    or "Kalimpong Runners")

    # ---- the event ---------------------------------------------------------
    st, _ = api.call("GET", f"/events/{CODE}")
    if st == 200:
        print(f"\n'{CODE}' already exists -- bringing it back to these settings.")
    else:
        st, body = api.call("POST", "/events", {"code": CODE, "name": NAME})
        if st != 201:
            print(f"  Could not create the race: {body.get('detail', st)}")
            raise SystemExit(1)
        print(f"\n  created the race '{CODE}'")

    # ---- the distances, with their prices ---------------------------------
    st, races = api.call("GET", f"/events/{CODE}/races")
    have = {r["name"]: r for r in (races if st == 200 else [])}
    # A rupee or two. Big enough to be a real UPI payment, small enough that
    # testing it costs nothing worth minding.
    for label, km, paise in (("10K", 10, 100), ("25K", 25, 200)):
        if label in have:
            api.call("PATCH", f"/races/{have[label]['id']}",
                     {"distance_km": km, "price_paise": paise})
            print(f"  {label}: ₹{paise / 100:g}")
        else:
            st, r = api.call("POST", f"/events/{CODE}/races",
                             {"name": label, "distance_km": km,
                              "price_paise": paise})
            print(f"  {label}: ₹{paise / 100:g}" if st == 201
                  else f"  could not add {label}: {r.get('detail', st)}")

    # ---- when, where, and what it is --------------------------------------
    opened = (datetime.now(timezone.utc) - timedelta(days=1)).replace(microsecond=0)
    closes = (datetime.now(timezone.utc) + timedelta(days=30)).replace(microsecond=0)
    st, body = api.call("PATCH", f"/events/{CODE}/schedule", {
        "starts_at": opened.isoformat(),
        "location": "Wherever you are",
        "description": (
            "A test virtual race, to try the whole thing out. Run 10K or 25K in "
            "your own time before the window closes, over as many runs as you "
            "like, with any watch, phone app or treadmill. Send a photo of each "
            "result. Finish the distance and your certificate is yours."),
        "entry_note": "This one is a test. Enter it, pay a rupee, and tell "
                      "Sanjay what felt wrong.",
        "is_published": True,
        "registration_open": True,
    })
    if st != 200:
        print(f"  Could not set the schedule: {body.get('detail', st)}")
        raise SystemExit(1)
    print(f"  open from {opened.date()} until {closes.date()}, published")

    # ---- and make it virtual ----------------------------------------------
    payload = {"is_virtual": True, "ends_at": closes.isoformat()}
    if upi:
        payload["upi_id"] = upi
        payload["upi_name"] = upi_name
        payload["payment_note"] = "Put your name in the payment note."
    st, body = api.call("PATCH", f"/events/{CODE}/virtual", payload)
    if st != 200:
        print(f"  Could not make it virtual: {body.get('detail', st)}")
        raise SystemExit(1)
    print("  marked as a virtual race"
          + (f", paid to {upi}" if upi else ""))

    print("\nDone. Three things to look at, in this order:\n")
    print(f"  1. {BASE}/            the card, as anybody sees it")
    print(f"  2. {BASE}/admin.html#{CODE}/virtual")
    print("                        your side: prices, the QR, runs to review")
    print(f"  3. {BASE}/virtual.html#{CODE}")
    print("                        a runner's side -- but enter from the home")
    print("                        page first, as a runner would\n")
    if not upi:
        print("No UPI id set, so the pay button has nowhere to point. Add one")
        print(f"under {BASE}/admin.html#{CODE}/virtual, with your QR image.\n")
    print("Test it from your phone, not this computer: the one thing no suite")
    print("here can check is whether a real UPI app opens and a real QR scans.")
    print("Delete the race from admin when you are finished with it.")


if __name__ == "__main__":
    main()
