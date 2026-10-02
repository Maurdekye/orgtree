"""Every section of the legacy org document, in order (design §5.2 step 3).

``sections()`` lists one Section per top-level key the engine can write: settings first, then
the agents every other section refers to, the docket, and the rest. ``registered_keys()`` is the
engine's own registry (``ledger.NODE_KEYED_SECTIONS``, plus the two legacy keys only older
builds wrote) minus the removed features' keys (``ledger.IGNORED_LEGACY_KEYS``), which the
converter does not carry (``ignored_keys()``), except ``KEPT_LEGACY``. A test fails unless the
sections own exactly those keys (design §5.2, "Mapper completeness").

``ddl()`` is the org schema these sections need, in creation order; the org migration that
creates it is checked against it (tests/test_orgdb_mappers.py).
"""

from __future__ import annotations

from .. import sections as _s
from ..sections import Section, Settings, StrList
from . import agents, docket, records, settings

LEGACY_ONLY = ("chain_notices", "release")

#: Removed features' keys the converter still carries exactly (design rev 7.2): the one-time
#: former-sandbox credential catch-up (registry_migration.run_former_sandbox_catchup) finds the
#: orgs it still has to catch up by their stored ``sandbox`` key, and in 3.2.0 it runs after
#: the conversion, on the new databases. Nothing else reads it.
KEPT_LEGACY = ("sandbox",)


def sections() -> list[Section]:
    return [
        Settings(settings.SETTINGS),
        agents.Nodes(),
        docket.Docket(),
        *records.sections(),
        StrList("work_deleted_names", "retired_slugs"),
    ]


def registered_keys() -> set[str]:
    from ... import ledger   # noqa: PLC0415
    return ((set(ledger.NODE_KEYED_SECTIONS) | set(LEGACY_ONLY) | set(KEPT_LEGACY))
            - set(ignored_keys()))


def ignored_keys() -> tuple[str, ...]:
    """The keys the converter does not carry: the removed features' keys but KEPT_LEGACY."""
    from ... import ledger   # noqa: PLC0415
    return tuple(k for k in ledger.IGNORED_LEGACY_KEYS if k not in KEPT_LEGACY)


def ddl() -> list[str]:
    out: list[str] = list(agents.TOOL_LISTS_DDL)
    secs = sections()
    nodes = next(s for s in secs if isinstance(s, agents.Nodes))
    for t in nodes.tables:
        out.extend(t.ddl())
    out.extend(_s.FRAMEWORK_DDL)
    for s in secs:
        if s is nodes:
            continue
        for t in s.tables:
            out.extend(t.ddl())
    return out
