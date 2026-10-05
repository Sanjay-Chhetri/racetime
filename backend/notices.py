"""Telling somebody what happened to their own entry.

Everything here is **transactional**: each notice is about a thing this person
did -- an entry they made, a run they sent in, money they paid. They are
deliberately **not** governed by `announcements_opt_in`, which covers news
about races nobody has entered yet. Somebody who pays for a race and is never
told the money arrived has been treated worse than somebody who gets one email
saying so, and consent to be contacted about your own order is not the same
question as consent to be marketed to.

The same rule as the contact form, for the same reason: **the database is the
record and email is a copy.** Nothing here raises, nothing here can stop a
decision from being saved, and with SMTP unset every one of these is a quiet
no-op while the app carries on working. The screens always show the truth
whether or not the mail got out.

Composing a notice and sending it are kept apart on purpose. The composers are
plain functions over plain values -- no ORM objects, no database, no network --
so what they say can be tested without either, which is where the mistakes in
this kind of code actually live.

Configure with the same SMTP_* variables the contact form uses, plus SITE_URL
for the links.
"""
import os
import smtplib
import ssl
from email.message import EmailMessage
from typing import Optional, Tuple

from . import mail

# Where the links point. A notice that says "your certificate is ready" with no
# way to reach it is an annoyance rather than a service.
SITE_URL = os.getenv("SITE_URL", "https://racetime-beta.vercel.app").rstrip("/")

SIGN_OFF = "You are getting this because you entered a race on RaceTime."


def rupees(paise: Optional[int]) -> str:
    """Paise to something a person reads, matching the screens."""
    value = (paise or 0) / 100
    return f"₹{value:,.0f}" if value == int(value) else f"₹{value:,.2f}"


def send(to_email: Optional[str], subject: str, body: str) -> Tuple[bool, Optional[str]]:
    """Returns (sent, error). Never raises.

    `Reply-To` is the organiser, not this server: somebody who replies to
    "your payment arrived" is replying to a person, and that reply should reach
    them rather than an unread mailbox.
    """
    if not to_email:
        # Email is optional on an account in everything but sign-up, and a
        # missing address is not an error worth reporting anywhere.
        return False, "no email address"
    if not mail.configured():
        return False, "SMTP is not configured on this server."

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = mail.SMTP_FROM
    msg["To"] = to_email
    msg["Reply-To"] = mail.CONTACT_EMAIL
    msg["Auto-Submitted"] = "auto-generated"       # keeps it out of vacation loops
    msg.set_content(f"{body}\n\n-- \n{SIGN_OFF}\n")

    try:
        context = ssl.create_default_context()
        if mail.SMTP_PORT == 465:
            with smtplib.SMTP_SSL(mail.SMTP_HOST, mail.SMTP_PORT,
                                  context=context, timeout=15) as server:
                server.login(mail.SMTP_USER, mail.SMTP_PASSWORD)
                server.send_message(msg)
        else:
            with smtplib.SMTP(mail.SMTP_HOST, mail.SMTP_PORT, timeout=15) as server:
                server.starttls(context=context)
                server.login(mail.SMTP_USER, mail.SMTP_PASSWORD)
                server.send_message(msg)
        return True, None
    except Exception as e:                  # noqa: BLE001 - reported, not raised
        return False, f"{type(e).__name__}: {e}"


# --------------------------------------------------------------------------
# What each notice says
#
# Short, specific, and it never asks them to come and find out what changed.
# The subject line alone should be enough to know what happened, because that
# is all most people will read.
# --------------------------------------------------------------------------

def _virtual_link(code: str) -> str:
    return f"{SITE_URL}/virtual.html#{code}"


def payment_settled(name: str, event_name: str, code: str, race: Optional[str],
                    amount_paise: int, waived: bool,
                    certificate_ready: bool) -> Tuple[str, str]:
    """An organiser has found the money, or decided not to ask for it."""
    what = "Entry fee waived" if waived else "Payment received"
    subject = f"{what} — {event_name}"
    opening = (
        f"Your entry fee for {event_name} has been waived."
        if waived else
        f"Your payment of {rupees(amount_paise)} for {event_name} has been "
        f"received and your entry is settled."
    )
    lines = [f"Hello {name},", "", opening]
    if race:
        lines += ["", f"Distance: {race}"]
    if certificate_ready:
        # They had already finished and were waiting on this. Two emails for
        # one moment is worse than one that says both things.
        lines += ["",
                  "You had already covered the distance, so your certificate "
                  "is ready now:",
                  f"  {_virtual_link(code)}"]
    else:
        lines += ["", "Your race page, whenever you want it:",
                  f"  {_virtual_link(code)}"]
    return subject, "\n".join(lines)


def run_rejected(name: str, event_name: str, code: str, distance_km: float,
                 ran_on: str, done_km: float, target_km: float,
                 note: Optional[str]) -> Tuple[str, str]:
    """The one notice somebody will be unhappy to get, so it says why."""
    subject = f"A run was not counted — {event_name}"
    lines = [
        f"Hello {name},",
        "",
        f"The organiser has not counted your {distance_km:g} km run from "
        f"{ran_on} towards {event_name}.",
    ]
    if note:
        lines += ["", f"What they said: {note}"]
    lines += [
        "",
        f"You are now at {done_km:g} km of {target_km:g} km.",
        "",
        "If you think this is a mistake, reply to this email — it goes to "
        "the organiser. You can also send the run again with a clearer "
        "screenshot:",
        f"  {_virtual_link(code)}",
    ]
    return subject, "\n".join(lines)


def run_counted(name: str, event_name: str, code: str, distance_km: float,
                ran_on: str, done_km: float, target_km: float) -> Tuple[str, str]:
    """A reversal. Somebody who was told no deserves to be told yes."""
    subject = f"Your run has been counted — {event_name}"
    return subject, "\n".join([
        f"Hello {name},",
        "",
        f"Your {distance_km:g} km run from {ran_on} is counted towards "
        f"{event_name} after all.",
        "",
        f"You are now at {done_km:g} km of {target_km:g} km.",
        "",
        f"  {_virtual_link(code)}",
    ])


def distance_finished(name: str, event_name: str, code: str,
                      race: Optional[str], target_km: float,
                      owed_paise: int) -> Tuple[str, str]:
    """They have covered the distance. Whether they get the card depends."""
    if owed_paise > 0:
        subject = f"You have finished the distance — {event_name}"
        tail = [
            "",
            f"Your certificate appears as soon as your entry is paid for. "
            f"{rupees(owed_paise)} is still outstanding — there is a button "
            f"on your race page that opens your UPI app:",
            f"  {_virtual_link(code)}",
        ]
    else:
        subject = f"Finished. Your certificate is ready — {event_name}"
        tail = [
            "",
            "Your certificate is on your race page, to share or to download:",
            f"  {_virtual_link(code)}",
        ]
    lines = [
        f"Hello {name},",
        "",
        f"That is {target_km:g} km done" + (f" — {race}." if race else "."),
        "Well run.",
    ] + tail
    return subject, "\n".join(lines)


def entry_decided(name: str, event_name: str, status: str,
                  race: Optional[str], bib: Optional[str],
                  when: Optional[str], where: Optional[str]) -> Tuple[str, str]:
    """An ordinary race: confirmed with a bib, or not accepted.

    This was silent until now. An entry sat as a request and the only way to
    learn it had been accepted was to keep checking the website.
    """
    if status == "confirmed":
        subject = f"You are in — {event_name}"
        lines = [f"Hello {name},", "",
                 f"Your entry for {event_name} is confirmed."]
        details = [("Distance", race), ("Your bib number", bib),
                   ("When", when), ("Where", where)]
        shown = [f"{label}: {value}" for label, value in details if value]
        if shown:
            lines += [""] + shown
        lines += ["", "Bring your bib, or a phone with it on the screen.",
                  f"  {SITE_URL}/me.html#entries"]
        return subject, "\n".join(lines)

    subject = f"About your entry — {event_name}"
    return subject, "\n".join([
        f"Hello {name},",
        "",
        f"Your entry for {event_name} has not been accepted. Reply to this "
        f"email if you would like to know why — it goes to the organiser.",
        "",
        f"  {SITE_URL}/me.html#entries",
    ])
