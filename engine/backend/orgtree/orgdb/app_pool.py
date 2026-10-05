"""App and default Host adapters over the registry's single idle cache."""
from __future__ import annotations

from typing import Any
from . import registry

MAX_IDLE = registry.IDLE_APP
connection = registry.session
close_idle = registry.close_idle


def org_connection(base: str, org: Any) -> Any:
    """Explicit Host target and identity; injected callbacks never enter here."""
    return registry.session(base, org.database, application_name='orgtree-jobs',
                            identity=(org.slug, org.org_uuid))
