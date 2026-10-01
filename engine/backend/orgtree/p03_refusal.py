"""A durable record of a P03 refusal (review N2).

When ``ORGTREE_P03_PROTOTYPE_ROOT`` is set but wrong, the door hook (or WS1's
host bracket) raises before the engine starts, and the desktop discards the
engine's stderr, so nothing on disk said why. :func:`record_refusal` writes
one entry to the Windows Application event log instead — NEVER into the data
root, which may be live (WS2/WS1 agreement, 2026-09-25 12:37Z, decision 1 on
``p03-ws2-follow-up-door-hardening-r1-r3-service-t``).

* Source ``Orgtree P03``. Event ID 1, type ERROR: a refusal (the guard worked,
  the engine did not start). Event ID 2, type WARNING: the variable is set but
  the hook stayed inert (the engine started without the door).
* The event text is one JSON object with schema ``orgtree.p03.refusal/v1``:
  ``component`` (``p03_door`` | ``p03_bracket``), ``refused`` (the reason),
  ``pid``, and the caller's fields (``data_root``, ``prototype_root`` ...).
* Best effort: a failed write returns ``False`` and never raises, so the
  refusal itself is raised unchanged.

Read it back with ``Get-EventLog -LogName Application -Source 'Orgtree P03'
-Newest 5 | Format-List``. The source is not registered (that needs admin),
so ``Get-WinEvent -FilterHashtable @{ProviderName=...}`` finds no provider
and its ``Message`` is empty; ``Get-EventLog`` and Event Viewer show a
"description cannot be found" note followed by the JSON, intact (measured
2026-09-25).
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
from typing import Any, Callable, Optional

SCHEMA = "orgtree.p03.refusal/v1"
SOURCE = "Orgtree P03"
COMPONENTS = frozenset({"p03_door", "p03_bracket"})
EVENT_REFUSED = 1
EVENT_INERT = 2
EVENTLOG_ERROR_TYPE = 0x0001
EVENTLOG_WARNING_TYPE = 0x0002
#: ReportEventW caps one insertion string at 31,839 characters.
MAX_TEXT = 31_000

Writer = Callable[[str, int, int], bool]


def payload(component: str, reason: str, **fields: Any) -> str:
    """The event text: one JSON object, ``pid`` defaulting to this process."""
    if component not in COMPONENTS:
        raise ValueError(f"unknown P03 component {component!r}")
    record = {"schema": SCHEMA, "component": component, "refused": str(reason), **fields}
    record.setdefault("pid", os.getpid())
    text = json.dumps(record, default=str)
    if len(text) > MAX_TEXT:
        record["refused"] = str(reason)[: MAX_TEXT // 2] + " [cut]"
        text = json.dumps(record, default=str)[:MAX_TEXT]
    return text


def record_refusal(component: str, reason: str, *, inert: bool = False,
                   writer: Optional[Writer] = None, **fields: Any) -> bool:
    """Write one event (ERROR id 1, or WARNING id 2 when ``inert``). Returns
    whether it was written; never raises. ``writer`` replaces the event-log
    call in tests."""
    try:
        text = payload(component, reason, **fields)
        event_id, event_type = (EVENT_INERT, EVENTLOG_WARNING_TYPE) if inert else (EVENT_REFUSED, EVENTLOG_ERROR_TYPE)
        return bool((writer or _report_event)(text, event_id, event_type))
    except Exception:  # noqa: BLE001  best effort by contract
        return False


def _report_event(text: str, event_id: int, event_type: int) -> bool:
    if sys.platform != "win32":
        return False
    from ctypes import wintypes  # noqa: PLC0415

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi.RegisterEventSourceW.restype = wintypes.HANDLE
    advapi.RegisterEventSourceW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    advapi.ReportEventW.restype = wintypes.BOOL
    advapi.ReportEventW.argtypes = [wintypes.HANDLE, wintypes.WORD, wintypes.WORD, wintypes.DWORD, ctypes.c_void_p,
                                    wintypes.WORD, wintypes.DWORD, ctypes.POINTER(wintypes.LPCWSTR), ctypes.c_void_p]
    advapi.DeregisterEventSource.argtypes = [wintypes.HANDLE]
    handle = advapi.RegisterEventSourceW(None, SOURCE)
    if not handle:
        return False
    try:
        strings = (wintypes.LPCWSTR * 1)(text)
        return bool(advapi.ReportEventW(handle, event_type, 0, event_id, None, 1, 0, strings, None))
    finally:
        advapi.DeregisterEventSource(handle)
