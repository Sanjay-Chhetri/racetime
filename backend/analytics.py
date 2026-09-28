"""Who is looking at the site, without knowing who they are.

Two things shaped this.

**It is server-side.** A tracking script would have to be added to every page,
including the finisher certificate — a page runners open on their phones and
share, and one this project has agreed not to touch. Counting in the middleware
covers every page without editing any of them, and it keeps working for someone
with an ad blocker, which on a results page is a large share of the audience.

**There is no identifier that outlives a day.** No cookie is set. To count
visitors rather than visits, each request is reduced to a hash of the address,
the browser string and a salt that changes at midnight UTC. The same person on
the same day is one visitor; tomorrow they are a new one. That loses week-long
retention figures and keeps the property that nothing stored can be turned back
into a person. For a race results page read by a few hundred neighbours, that
is the right side of the trade.

What this cannot tell you is how long someone stayed. That needs a script on
the page reporting back, which is exactly what is being avoided.
"""
import hashlib
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from .models import PageView, utcnow

# A secret would be better than the deployment's own name, but the salt already
# changes daily, so the window in which a guessed hash means anything is one
# day and the answer is only "this request came from the same browser as that
# one". ANALYTICS_SALT sets it explicitly where that matters.
_SECRET = os.getenv("ANALYTICS_SALT", "") or os.getenv("DATABASE_URL", "racetime")

RETENTION_DAYS = 90

# Pages worth counting. Everything else -- stylesheets, scripts, icons, the API
# itself -- would be thirty rows per visit saying nothing.
_PAGES = {
    "/", "/index.html", "/results.html", "/certificate.html",
    "/checkpoint.html", "/guide.html", "/login.html", "/admin.html",
}

_RESULTS_CALL = re.compile(r"^/api/events/([^/]+)/results$")

_BOT = re.compile(
    r"bot|crawler|spider|crawling|slurp|bingpreview|facebookexternalhit|"
    r"headlesschrome|python-urllib|curl/|wget|playwright|lighthouse",
    re.I)


def _day_salt(now: datetime) -> str:
    return f"{_SECRET}:{now.strftime('%Y-%m-%d')}"


def visitor_hash(ip: str, user_agent: str, now: Optional[datetime] = None) -> str:
    now = now or utcnow()
    raw = f"{_day_salt(now)}|{ip}|{user_agent}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def client_ip(request) -> str:
    """The address as the platform reports it.

    Behind a proxy the socket is the proxy, so the first hop in
    X-Forwarded-For is the client. It is only ever fed into a hash.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "?"


def device_of(user_agent: str) -> str:
    ua = user_agent.lower()
    if "ipad" in ua or "tablet" in ua:
        return "tablet"
    if "mobi" in ua or "android" in ua or "iphone" in ua:
        return "phone"
    return "desktop"


def referrer_host(referer: str, own_host: str) -> Optional[str]:
    """The bare hostname someone arrived from, or None.

    A full referring URL can carry search terms and identifiers, so only the
    host is kept. Links from inside the site are not arrivals and are dropped.
    """
    if not referer:
        return None
    try:
        host = referer.split("//", 1)[-1].split("/", 1)[0].split(":")[0].lower()
    except (IndexError, AttributeError):
        return None
    if not host or host == (own_host or "").lower():
        return None
    return host[:120]


def what_to_record(path: str) -> tuple[bool, Optional[str]]:
    """(record?, event code). A page is a visit; a results call names a race."""
    if path in _PAGES:
        return True, None
    m = _RESULTS_CALL.match(path)
    if m:
        # Not a visit in its own right -- the page that made this call was
        # already counted -- but it is how the race gets attached to it.
        return True, m.group(1)
    return False, None


def record(db: DbSession, request, path: str, event_code: Optional[str]) -> None:
    """Best effort. Analytics must never be the reason a page fails to load."""
    ua = request.headers.get("user-agent", "")
    if _BOT.search(ua):
        return
    try:
        now = utcnow()
        visitor = visitor_hash(client_ip(request), ua, now)

        if event_code:
            # Attach the race to this visitor's most recent page view instead
            # of adding a row, so one visit stays one visit.
            recent = (db.query(PageView)
                      .filter(PageView.visitor == visitor,
                              PageView.event_code.is_(None),
                              PageView.at > now - timedelta(minutes=10))
                      .order_by(PageView.at.desc())
                      .first())
            if recent is not None:
                recent.event_code = event_code[:24]
                db.commit()
            return

        db.add(PageView(
            at=now,
            path=path[:120],
            visitor=visitor,
            referrer=referrer_host(request.headers.get("referer", ""),
                                   request.headers.get("host", "")),
            device=device_of(ua),
        ))
        db.commit()
    except Exception:
        # A failed count is not worth a 500 on a results page mid-race.
        db.rollback()


def prune(db: DbSession) -> int:
    cutoff = utcnow() - timedelta(days=RETENTION_DAYS)
    n = db.query(PageView).filter(PageView.at < cutoff).delete()
    if n:
        db.commit()
    return n


# --------------------------------------------------------------------------
# Reading it back
# --------------------------------------------------------------------------

def _since(days: int) -> datetime:
    return utcnow() - timedelta(days=days)


def summary(db: DbSession, days: int = 30) -> dict:
    """Everything the analytics screen shows, in one pass."""
    start = _since(days)
    rows = (db.query(PageView)
            .filter(PageView.at >= start, PageView.path != "/admin.html")
            .all())

    def bucket(key):
        out = {}
        for r in rows:
            k = key(r)
            if k:
                out[k] = out.get(k, 0) + 1
        return sorted(out.items(), key=lambda kv: -kv[1])

    # Views by day, with the quiet days included rather than skipped -- a gap
    # in a chart reads as "no data", not "nobody came".
    per_day = {}
    per_day_visitors = {}
    for r in rows:
        d = (r.at if r.at.tzinfo else r.at.replace(tzinfo=timezone.utc)).date().isoformat()
        per_day[d] = per_day.get(d, 0) + 1
        per_day_visitors.setdefault(d, set()).add(r.visitor)

    today = utcnow().date()
    daily = []
    for i in range(days - 1, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        daily.append({"date": d,
                      "views": per_day.get(d, 0),
                      "visitors": len(per_day_visitors.get(d, ()))})

    # Hour of day, in the organiser's own timezone rather than UTC -- "busiest
    # at 03:00" is useless when the race was at 09:00 local.
    hours = [0] * 24
    for r in rows:
        at = r.at if r.at.tzinfo else r.at.replace(tzinfo=timezone.utc)
        hours[at.hour] += 1

    return {
        "days": days,
        "views": len(rows),
        "visitors": len({r.visitor for r in rows}),
        "daily": daily,
        "hours": hours,
        "pages": [{"path": k, "views": v} for k, v in bucket(lambda r: r.path)][:10],
        "races": [{"code": k, "views": v} for k, v in bucket(lambda r: r.event_code)][:10],
        "referrers": [{"host": k, "views": v} for k, v in bucket(lambda r: r.referrer)][:10],
        "devices": [{"device": k, "views": v} for k, v in bucket(lambda r: r.device)],
        "retention_days": RETENTION_DAYS,
    }
