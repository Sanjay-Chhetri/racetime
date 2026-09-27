"""Who you are, and what that lets you do.

Two decisions shape this file.

**Passwords are hashed with PBKDF2-HMAC-SHA256 from the standard library.**
bcrypt and argon2 are better algorithms, but they are compiled dependencies,
and this app has to install cleanly on a serverless runtime where a wheel that
does not match the platform is a deployment that never boots. PBKDF2 at a high
iteration count is not the strongest option available; it is a sound one that
cannot fail to install. The stored format carries its own parameters, so the
iteration count can be raised later and old hashes still verify -- and are
upgraded silently the next time their owner signs in.

**Sessions live in the database, not in a signed token.** A self-contained
token is one fewer query, but it cannot be withdrawn: sacking someone means
waiting for their token to expire. A row can be deleted. What the row stores is
the SHA-256 of the token, not the token, so a leaked backup does not hand over
live sessions -- the same reason the password column holds a digest.
"""
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session as DbSession

from .db import get_db
from .models import ROLES, Session, User, utcnow

# --------------------------------------------------------------------------
# Passwords
# --------------------------------------------------------------------------

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 600_000          # OWASP's 2023 floor for PBKDF2-HMAC-SHA256
SALT_BYTES = 16


def hash_password(password: str) -> str:
    """`pbkdf2_sha256$<iterations>$<salt_hex>$<digest_hex>`."""
    if not password:
        raise ValueError("password must not be empty")
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return f"{ALGORITHM}${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check. Never raises on a malformed hash -- a corrupted
    row should fail the login, not return a 500 that says the row is corrupt."""
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$")
        if algorithm != ALGORITHM:
            return False
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations))
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(actual, expected)


def needs_rehash(stored: str) -> bool:
    """True when a hash was made with weaker parameters than we now use."""
    try:
        algorithm, iterations, _, _ = stored.split("$")
        return algorithm != ALGORITHM or int(iterations) < ITERATIONS
    except (ValueError, AttributeError):
        return True


# --------------------------------------------------------------------------
# Sessions
# --------------------------------------------------------------------------

COOKIE_NAME = "racetime_session"
SESSION_HOURS = 12            # a race day, not a fortnight
RENEW_AFTER_HOURS = 2         # slide the expiry, but do not write on every call

# Vercel and friends set these. On a platform we do not recognise the cookie is
# still marked Secure whenever the request itself arrived over HTTPS.
_SERVERLESS = ("VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "FUNCTION_TARGET")


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    """SQLite drops tzinfo on the way out; compare in UTC or not at all."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def start_session(db: DbSession, user: User, response: Response,
                  request: Request) -> str:
    """Create a session row and set the cookie. Returns the raw token."""
    raw = secrets.token_urlsafe(32)               # 256 bits
    now = utcnow()
    row = Session(
        token_hash=token_hash(raw),
        user_id=user.id,
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(hours=SESSION_HOURS),
        user_agent=(request.headers.get("user-agent") or "")[:200] or None,
    )
    db.add(row)
    user.last_login_at = now
    db.commit()
    _set_cookie(response, raw, request)
    return raw


def _is_https(request: Request) -> bool:
    if any(os.getenv(v) for v in _SERVERLESS):
        return True
    # A proxy terminates TLS, so the scheme on the socket is not the whole story.
    if request.headers.get("x-forwarded-proto", "").split(",")[0].strip() == "https":
        return True
    return request.url.scheme == "https"


def _set_cookie(response: Response, raw: str, request: Request) -> None:
    response.set_cookie(
        COOKIE_NAME, raw,
        max_age=SESSION_HOURS * 3600,
        httponly=True,          # JavaScript cannot read it, so XSS cannot steal it
        samesite="lax",         # blocks the cross-site POST that CSRF depends on
        secure=_is_https(request),
        path="/",
    )


def clear_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")


def end_session(db: DbSession, raw: Optional[str]) -> None:
    if not raw:
        return
    row = db.get(Session, token_hash(raw))
    if row:
        db.delete(row)
        db.commit()


def purge_expired(db: DbSession) -> int:
    """Housekeeping. Cheap, and keeps the table from growing without bound."""
    n = db.query(Session).filter(Session.expires_at < utcnow()).delete()
    if n:
        db.commit()
    return n


# --------------------------------------------------------------------------
# Dependencies
# --------------------------------------------------------------------------

def resolve_session(db: DbSession, raw: Optional[str]) -> Optional[int]:
    """Validate a session token and return the user's id, or None.

    It deliberately returns an **id, not a User**. The middleware that calls
    this opens its own short-lived database session and closes it immediately,
    so any ORM object it handed on would be detached: an endpoint could set a
    field on it, commit its own session, and write nothing at all. That is
    exactly the bug that let a password change answer 204 while leaving the
    old password working. An integer cannot go stale.
    """
    if not raw:
        return None
    row = db.get(Session, token_hash(raw))
    if row is None:
        return None
    if _aware(row.expires_at) < utcnow():
        db.delete(row)
        db.commit()
        return None
    user = row.user
    if user is None or not user.is_active:
        # The account was disabled or deleted while the browser held a session.
        db.delete(row)
        db.commit()
        return None

    # Slide the expiry so an operator working through a race day is not thrown
    # out mid-edit, without writing to the database on every single request.
    now = utcnow()
    if now - _aware(row.last_seen_at) > timedelta(hours=RENEW_AFTER_HOURS):
        row.last_seen_at = now
        row.expires_at = now + timedelta(hours=SESSION_HOURS)
        db.commit()
    return user.id


def signed_in_id(request: Request) -> Optional[int]:
    return getattr(request.state, "user_id", None)


def optional_user(request: Request,
                  db: DbSession = Depends(get_db)) -> Optional[User]:
    """Whoever is signed in, or None. Never raises.

    The User comes from the request's own database session, so an endpoint may
    modify and commit it.
    """
    uid = signed_in_id(request)
    return db.get(User, uid) if uid else None


def _deny(detail: str, status: int = 401):
    # 401 means "say who you are"; 403 means "I know who you are, and no".
    headers = {"WWW-Authenticate": "Cookie"} if status == 401 else None
    return HTTPException(status_code=status, detail=detail, headers=headers)


def require_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    user = optional_user(request, db)
    if user is None:
        raise _deny("Sign in to continue.")
    return user


def require_role(minimum: str):
    """A dependency demanding `minimum` or better.

    Roles are ordered, so one comparison covers "admin or above" without
    naming every role that qualifies -- and adding a role later does not mean
    revisiting every endpoint.
    """
    if minimum not in ROLES:
        raise ValueError(f"unknown role: {minimum}")
    floor = ROLES.index(minimum)

    def dependency(request: Request, db: DbSession = Depends(get_db)) -> User:
        user = require_user(request, db)
        if ROLES.index(user.role) < floor:
            raise _deny(
                "Your account does not have permission for that."
                + (" Only a super admin can do this." if minimum == "super_admin" else ""),
                status=403)
        return user

    return dependency


require_admin = require_role("admin")
require_super_admin = require_role("super_admin")

ADMIN = [Depends(require_admin)]
SUPER = [Depends(require_super_admin)]


# --------------------------------------------------------------------------
# First-run accounts
# --------------------------------------------------------------------------

def seed_users(db: DbSession) -> None:
    """Create the starting accounts, once, if there are none at all.

    Only runs against an empty users table, so it can never overwrite a
    password someone has since changed. RACETIME_SEED_USERS overrides the
    defaults as `name:password:role,name:password:role`.
    """
    if db.query(User).first() is not None:
        return

    spec = os.getenv("RACETIME_SEED_USERS", "").strip()
    if spec:
        entries = []
        for chunk in spec.split(","):
            parts = [p.strip() for p in chunk.split(":")]
            if len(parts) == 3 and parts[2] in ROLES:
                entries.append(tuple(parts))
    else:
        entries = [
            ("sanjay", "sanjay", "super_admin"),
            ("sajal", "sajal", "super_admin"),
            ("johny", "johny", "admin"),
            ("sherap", "sherap", "admin"),
        ]

    for username, password, role in entries:
        db.add(User(
            username=username.lower(),
            display_name=username.title(),
            password_hash=hash_password(password),
            role=role,
            # These passwords are the usernames. They exist so the system can
            # be used today, not so it can be left like this.
            must_change_password=(username == password),
        ))
    db.commit()
    print(f"  Created {len(entries)} operator account(s).")
    if not spec:
        print("  WARNING: seeded with default passwords that match the usernames.")
        print("  Every account is flagged to change its password on first use.")
