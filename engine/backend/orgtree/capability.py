# pyright: strict
"""Provenance for CAPABILITY conclusions — "this lane cannot report usage".

⚠ WHY THIS MODULE EXISTS. A capability conclusion is a measurement, and this
codebase kept storing them as facts. The Antigravity `/usage` command was
concluded unreadable once, against one CLI build, and that "unsupported"
became a permanent property of the provider — while the CLI it was measured
against had long since grown a structured, zero-token `/usage` result. Nobody
could see the conclusion was old, because the conclusion did not say when, or
against what, it had been reached (AU01, 2026-09-12).

So every negative this codebase publishes now carries the same four facts:

    cli        which command line the conclusion is about
    version    the version of it that was OBSERVED when the conclusion was
               reached — `null` when nothing has observed one yet, never a
               guess and never a constant copied out of a comment
    basis      WHY the lane cannot answer, which decides whether the negative
               is re-decidable at all (see `BASES` below)
    observed_at  the instant the conclusion was reached

`stale(observation, version)` is the other half: a version-basis negative
whose observed version is no longer the version installed has stopped being
evidence, and its holder must recompute rather than republish it. That is the
whole of the invalidation rule — a changed CLI drops the old answer, and the
next ordinary read re-derives it through the lane's own zero-turn probe where
one exists.

⚠ NO PROBE LIVES HERE. This module formats and compares evidence; it never
runs a CLI, opens a socket or reads a credential, because its callers include
the turn-envelope path whose whole promise is that it does none of those
things. `cli_version_cached` is deliberately cache-only for the same reason:
an unobserved version is reported as unobserved, which is the honest answer,
and is never worth a subprocess on a path that renders once per agent turn.

⚠ AND NOTHING HERE FORECASTS. A capability record says what was observed
about a lane's ability to REPORT usage. It never says how much room an
account has, never estimates remaining turns, and is never an admission gate:
`available: False` means "no reading", which is not the same as "no capacity"
and must never be read as either zero or room (user rule 2026-09-12).
"""
from __future__ import annotations

import datetime as _dt
import re
from collections.abc import Mapping
from typing import Any, Final

#: Why a lane cannot report usage. The distinction that matters is whether a
#: newer CLI could change the answer:
#:
#:   `version`              the installed CLI is older than the build whose
#:                          read-only behaviour was verified — re-decidable by
#:                          upgrading, so `stale` must drop it on any change
#:   `scope`                the credential can never carry the permission the
#:                          usage endpoint needs (a `claude setup-token` key,
#:                          D-147) — not re-decidable by this machine, but
#:                          still recorded against a version so it cannot
#:                          become a fact nobody ever re-examines
#:   `no-profile-selector`  the CLI can only answer for the account it is
#:                          ambiently signed into, so a non-ambient profile
#:                          has no question to ask
#:   `billing`             the lane bills per request and publishes no
#:                          subscription window at all
BASES: Final = ("version", "scope", "no-profile-selector", "billing")

#: What a version string is reduced to before two of them are compared. The
#: providers print `1.2.7`, `agy version 1.2.7`, `0.150.1-alpha` and (when a
#: probe fails) nothing at all; comparing the raw strings would call a
#: reformatted banner a new CLI and re-probe on every read.
_VERSION_RE: Final = re.compile(r"(\d+(?:\.\d+)*)")

UNOBSERVED: Final = "unobserved"


def _iso(epoch: float) -> str | None:
    try:
        value = float(epoch)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    try:
        return (_dt.datetime.fromtimestamp(value, tz=_dt.timezone.utc)
                .isoformat().replace("+00:00", "Z"))
    except (OverflowError, OSError, ValueError):
        return None


def version_key(version: object) -> str:
    """The comparable identity of an observed CLI version.

    `UNOBSERVED` when nothing was observed, so an unobserved version never
    compares equal to an observed one — a negative reached while the CLI was
    missing is not evidence about the CLI that appeared afterwards.
    """
    if isinstance(version, bool) or version is None:
        return UNOBSERVED
    match = _VERSION_RE.search(str(version))
    return match.group(1) if match else (str(version).strip() or UNOBSERVED)


def observation(*, cli: str, basis: str, version: object,
                supported: bool = False, requires: object = None,
                detail: str = "", observed_at: float | None = None,
                ) -> dict[str, Any]:
    """One capability conclusion, with the provenance that makes it re-checkable.

    `{cli, supported, basis, version, version_observed, requires?, detail?,
      observed_at}`. `version` is the comparable key and `version_observed` is
      the raw string a person can match against `--version` output; both are
      present because the key is lossy on purpose.

    ⚠ `observed_at` IS THE INSTANT THE EVIDENCE WAS OBSERVED, NOT THE INSTANT
    THIS RECORD WAS FORMATTED, and it is `null` when the caller cannot say.
    Two reasons, both load-bearing. Honesty: a record built from a version
    another surface observed at some unknown earlier time is not a fresh
    observation, and stamping it `now` would date the formatting and read as
    the measurement. Determinism: these records are returned by
    `accountusage.view`, which the Usage modal and the turn envelope must
    answer identically from the same state — a wall-clock field would make the
    two disagree byte for byte on every read, and a pinned test proves they
    do not.
    """
    out: dict[str, Any] = {
        "cli": str(cli or ""),
        "supported": bool(supported),
        "basis": str(basis) if str(basis) in BASES else "unknown",
        "version": version_key(version),
        "version_observed": (None if version is None or isinstance(version, bool)
                             else str(version) or None),
        "observed_at": None if observed_at is None else _iso(observed_at),
    }
    if requires is not None:
        out["requires"] = str(requires)
    if detail:
        out["detail"] = detail
    return out


def stale(record: Mapping[str, Any] | None, version: object) -> bool:
    """Has this capability conclusion stopped being evidence?

    True when the record is missing its provenance, or when the CLI version it
    was reached against is not the version installed now. A caller holding a
    negative that is `stale` must recompute it — that is what stops a
    measurement against an old build from outliving the build (AU01).

    ⚠ A CHANGE IN EITHER DIRECTION COUNTS, including back to `UNOBSERVED`. An
    upgrade is the case that motivated this, but a downgrade invalidates a
    positive just as completely, and a CLI that has vanished invalidates
    everything measured while it was there.
    """
    if not isinstance(record, Mapping):
        return True
    recorded = record.get("version")
    if not isinstance(recorded, str) or not recorded:
        return True
    return recorded != version_key(version)


def cli_version_cached(cli: str) -> str | None:
    """An ALREADY-OBSERVED version of one CLI, or None — never a probe.

    The turn envelope reaches capability records through `accountusage.view`
    with `allow_fetch=False`, a hard promise of no subprocess, no socket and
    no credential read. So this reads only what another surface has already
    observed and reports None otherwise: "nothing has looked" is an honest
    provenance value and a subprocess per agent per turn is not worth
    replacing it with.
    """
    try:
        if cli == "claude":
            from . import supervisor              # noqa: PLC0415 — one lane
            return supervisor.cli_version_cached()
        if cli == "antigravity":
            from . import providers               # noqa: PLC0415 — one lane
            status = providers.antigravity_cached_status()
            if not isinstance(status, dict):
                return None
            version = status.get("version")
            return str(version) if isinstance(version, str) and version else None
    except Exception:                                          # noqa: BLE001
        return None
    return None
