"""Every section of the legacy org document, in order (design §5.2 step 3).

``sections()`` lists one Section per top-level key the engine can write: settings first, then
the agents every other section refers to, the docket, and the rest. ``registered_keys()`` is the
engine's own registry (``ledger.NODE_KEYED_SECTIONS``, plus the two legacy keys only older
builds wrote) minus the removed features' keys (``ledger.IGNORED_LEGACY_KEYS``). A test fails
unless the sections own exactly those keys (design §5.2, "Mapper completeness").

``ddl()`` is the org schema these sections need, in creation order; the org migration that
creates it is checked against it (tests/test_orgdb_mappers.py).
"""

from __future__ import annotations

from .. import sections as _s
from ..sections import Section, Settings, StrList
from . import agents, docket, records, settings

LEGACY_ONLY = ("chain_notices", "release")


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
    return (set(ledger.NODE_KEYED_SECTIONS) | set(LEGACY_ONLY)) - set(ledger.IGNORED_LEGACY_KEYS)


def ignored_keys() -> tuple[str, ...]:
    from ... import ledger   # noqa: PLC0415
    return tuple(ledger.IGNORED_LEGACY_KEYS)


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
