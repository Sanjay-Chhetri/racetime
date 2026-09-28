"""Sending the contact form on to the organiser.

The message is written to the database before this is called, and never
instead of it. Mail needs credentials that may not be set, a host that may be
blocked, and a network that may be down; a contact form which drops what
somebody wrote because SMTP was misconfigured is worse than no contact form at
all. So the database is the record, and email is a convenience on top.

Configure with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, and optionally
CONTACT_EMAIL for the destination. With none of them set, nothing is sent, the
form still works, and the admin screen says plainly that mail is not
configured — rather than implying messages went somewhere they did not.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Optional

CONTACT_EMAIL = os.getenv("CONTACT_EMAIL", "sanjay.chhetri4u@gmail.com")

SMTP_HOST = os.getenv("SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "").strip()
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "").strip()
SMTP_FROM = os.getenv("SMTP_FROM", "").strip() or SMTP_USER


def configured() -> bool:
    return bool(SMTP_HOST and SMTP_USER and SMTP_PASSWORD)


def status() -> dict:
    """What the admin screen shows about mail, without leaking the password."""
    return {
        "configured": configured(),
        "to": CONTACT_EMAIL if configured() else None,
        "host": SMTP_HOST or None,
    }


def send_contact(name: str, email: str, subject: str, body: str,
                 site: str = "RaceTime") -> tuple[bool, Optional[str]]:
    """Returns (sent, error). Never raises -- the caller has already saved it."""
    if not configured():
        return False, "SMTP is not configured on this server."

    msg = EmailMessage()
    msg["Subject"] = f"[{site}] {subject}"
    msg["From"] = SMTP_FROM
    msg["To"] = CONTACT_EMAIL
    # So hitting reply goes to the person who wrote, not to the server account.
    # The address is unverified, which is why it is Reply-To and not From --
    # forging From is how mail ends up in a spam folder.
    msg["Reply-To"] = f"{name} <{email}>" if name else email
    msg.set_content(
        f"From: {name} <{email}>\n"
        f"Subject: {subject}\n\n"
        f"{body}\n\n"
        f"-- \nSent from the {site} contact form."
    )

    try:
        context = ssl.create_default_context()
        if SMTP_PORT == 465:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context,
                                  timeout=15) as server:
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                server.starttls(context=context)
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.send_message(msg)
        return True, None
    except Exception as e:                      # noqa: BLE001 - reported, not raised
        return False, f"{type(e).__name__}: {e}"
