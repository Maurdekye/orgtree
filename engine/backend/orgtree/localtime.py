# pyright: strict
"""Timestamps inside server-written prose the user reads.

Assignment 19: every application-generated timestamp the user can see renders
in the user's own timezone. Stored instants are unchanged — UTC ISO-8601 with
a trailing ``Z``, everywhere, as before.

THE PROBLEM THIS SOLVES. Most of the product formats timestamps in the
browser, which simply knows the zone. But some user-visible text is *prose the
server writes* — the mail header replayed in an agent's chat is built when the
mail is delivered and stored as a durable row. The server cannot format it: it
does not know the user's zone, and even a recorded copy would be wrong later
if the user moved or the row were reread in another zone.

SO THE SERVER DOES NOT FORMAT IT. It writes the canonical instant inside a
token, and the browser turns that token into local text at render
(``timefmt.localizeStamps``, applied inside ``md()``). Consequences worth
naming:

  · the durable row keeps the canonical instant, so it relocalises on every
    read instead of freezing whatever was true when it was written;
  · identity checks (``supervisor.mail_marker_in``) match on that canonical
    instant, so they are unaffected by a zone change;
  · there is no recorded server-side zone to go stale, and no fallback that
    could quietly render UTC or the server's own clock.

Earlier drafts formatted here, using a zone the browser had reported. Two
defects killed that approach (coordinator review, 2026-09-05): a stored
numeric UTC offset is not valid across a daylight-saving transition, and prose
written once was still being read long afterwards. Both are structural, not
tuning. Rendering at read time has neither.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Final

#: Deliberately obscure so ordinary prose cannot collide with it, and
#: markdown-inert so it survives to the substitution step.
OPEN: Final = "⟦t:"
CLOSE: Final = "⟧"

#: How the browser should render the instant. The backend picks the shape; the
#: zone is never its business.
#:   stamp → 2026-09-05 04:11        full → 2026-09-05 04:11:27 IDT
#:   clock → 4:11 AM (dated when not today)
STYLES: Final = frozenset({"stamp", "full", "clock"})

_TOKEN_RE: Final = re.compile(
    re.escape(OPEN) + r"([^|⟧]+)\|([a-z]+)" + re.escape(CLOSE))


def _fmt(at: _dt.datetime) -> str:
    """Milliseconds, matching ``ledger.now()`` — the shape every stored instant
    in this codebase already has. One spelling is what keeps the identity
    needles in ``supervisor.mail_marker_in`` deterministic."""
    return at.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def to_iso(value: str | float | int | None) -> str | None:
    """A canonical instant as a UTC ISO-8601 string, or None if unreadable.

    Accepts the ISO strings the org document stores and the epoch seconds (or
    milliseconds) a few call sites carry. A naive ISO string is read as UTC,
    which is what every producer in this codebase writes.
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        secs = float(value)
        # 1e11 ms is 1973 and 1e11 s is the year 5138, so nothing this
        # application holds falls between the two readings
        if abs(secs) >= 1e11:
            secs /= 1000.0
        try:
            at = _dt.datetime.fromtimestamp(secs, _dt.timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
        return _fmt(at)
    text = str(value).strip()
    if not text:
        return None
    probe = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        at = _dt.datetime.fromisoformat(probe)
    except ValueError:
        return None
    if at.tzinfo is None:
        at = at.replace(tzinfo=_dt.timezone.utc)
    return _fmt(at.astimezone(_dt.timezone.utc))


def token(value: str | float | int | None, style: str = "stamp") -> str:
    """Mark an instant for the browser to render locally.

    Returns "" for an instant that cannot be read — a stamp we cannot parse is
    one we must not draw, and emitting the raw field is how a UTC string
    reached the screen before this change.
    """
    iso = to_iso(value)
    if iso is None:
        return ""
    return f"{OPEN}{iso}|{style if style in STYLES else 'stamp'}{CLOSE}"


def instants_in(text: str) -> list[str]:
    """The canonical instants a piece of prose carries. For tests and for any
    reader that needs the machine value back out of a rendered row."""
    return [m.group(1) for m in _TOKEN_RE.finditer(text or "")]
