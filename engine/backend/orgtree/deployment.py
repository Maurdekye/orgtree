# pyright: strict
"""Machine-wide deployment policy selection.

Every component consumes :func:`current_policy`; no caller should parse the
selector environment variable itself.  The selector is intentionally small:
an unknown security profile is a configuration error, never a request to fall
back to the more permissive standard policy.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Literal


PROFILE_ENV = "ORGTREE_DEPLOYMENT_PROFILE"
DeploymentProfileName = Literal["standard", "frozen"]


class DeploymentConfigError(RuntimeError):
    """The install-wide deployment policy could not be selected safely."""


@dataclass(frozen=True)
class DeploymentPolicy:
    """Security decisions that must agree across the whole installation."""

    name: DeploymentProfileName
    require_sandboxed_orgs: bool
    allow_agent_restart: bool
    allow_public_listener: bool
    allow_admin_exposure: bool
    allow_legacy_sandbox_credentials: bool
    allow_sandbox_internet: bool
    allow_broad_anthropic_proxy: bool


STANDARD = DeploymentPolicy(
    name="standard",
    require_sandboxed_orgs=False,
    allow_agent_restart=True,
    allow_public_listener=True,
    allow_admin_exposure=True,
    allow_legacy_sandbox_credentials=True,
    allow_sandbox_internet=True,
    allow_broad_anthropic_proxy=True,
)

FROZEN = DeploymentPolicy(
    name="frozen",
    require_sandboxed_orgs=True,
    allow_agent_restart=False,
    allow_public_listener=False,
    allow_admin_exposure=False,
    allow_legacy_sandbox_credentials=False,
    allow_sandbox_internet=False,
    allow_broad_anthropic_proxy=False,
)

_PROFILES: dict[str, DeploymentPolicy] = {
    STANDARD.name: STANDARD,
    FROZEN.name: FROZEN,
}


def current_policy() -> DeploymentPolicy:
    """Return the authoritative install-wide policy.

    Unset or blank preserves the existing standard deployment.  Unknown
    values fail closed so a typo cannot silently disable hardening.
    """

    raw = os.environ.get(PROFILE_ENV, "")
    name = raw.strip().lower() or STANDARD.name
    try:
        return _PROFILES[name]
    except KeyError as e:
        shown = raw if len(raw) <= 80 else raw[:77] + "..."
        raise DeploymentConfigError(
            f"{PROFILE_ENV} must be 'standard' or 'frozen'; got {shown!r}. "
            "Refusing to use a less restrictive fallback for an unknown "
            "deployment profile."
        ) from e
