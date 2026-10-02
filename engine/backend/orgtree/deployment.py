# pyright: strict
"""Machine-wide deployment policy selection.

Every component consumes :func:`current_policy`; no caller should parse the
selector environment variable itself.  Only the "standard" profile exists.
The removed "frozen" profile and any unknown value are configuration errors,
never a request to fall back silently to the standard policy.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Literal


PROFILE_ENV = "ORGTREE_DEPLOYMENT_PROFILE"
DeploymentProfileName = Literal["standard"]

#: Profiles that existed once and are now refused by name at startup.
_REMOVED_PROFILES = frozenset({"frozen"})


class DeploymentConfigError(RuntimeError):
    """The install-wide deployment policy could not be selected safely."""


@dataclass(frozen=True)
class DeploymentPolicy:
    """The install-wide deployment policy."""

    name: DeploymentProfileName


STANDARD = DeploymentPolicy(name="standard")


def current_policy() -> DeploymentPolicy:
    """Return the authoritative install-wide policy.

    Unset or blank selects the standard deployment.  The removed "frozen"
    profile and unknown values raise, so a stale or mistyped selector stops
    startup instead of being silently ignored.
    """

    raw = os.environ.get(PROFILE_ENV, "")
    name = raw.strip().lower() or STANDARD.name
    if name == STANDARD.name:
        return STANDARD
    if name in _REMOVED_PROFILES:
        raise DeploymentConfigError(
            f"{PROFILE_ENV}={name!r}: the {name!r} deployment profile has "
            "been removed; 'standard' is the only supported profile. Unset "
            f"{PROFILE_ENV} or set it to 'standard', then start orgtree again.")
    shown = raw if len(raw) <= 80 else raw[:77] + "..."
    raise DeploymentConfigError(
        f"{PROFILE_ENV} must be 'standard'; got {shown!r}. Refusing to "
        "guess a deployment profile from an unknown value.")
