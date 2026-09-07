# pyright: strict
"""Machine-wide application preferences.

These settings apply to every org under this ORGTREE_DATA root. They are not
org document fields: changing the active org must never change whether this
machine admits a provider. Display-only preferences remain in browser
localStorage because text scale and canvas density belong to the screen being
used, not to the backend machine.

The first record is D-203's per-provider admission switch. Runtime also owns
the machine-wide stale-working checkup mode, the optional MCP-readiness
admission gate and the optional idle docket reminder. Providers and working
checkups are default-on; the readiness gate and the docket reminder are
deliberately default-off so existing installs preserve today's no-wait turn
startup, and today's wake volume, unless the operator opts in.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from typing import Any, Final

from . import store

VERSION: Final = 1
FILE_NAME: Final = "app-settings.json"
#: "openrouter" (2026-09-02) is the first API-backed lane — same on/off
#: switch as the CLI providers; its key lives in openrouter.py's own state
#: file, never here
PROVIDERS: Final = frozenset({"claude", "openai", "google", "openrouter"})
_LOCK = threading.RLock()


class AppSettingsUnreadable(RuntimeError):
    """An existing settings record cannot be safely read or overwritten."""


def path() -> str:
    """Resolve per call: tests replace store.DATA_ROOT after module import."""
    return os.path.join(store.DATA_ROOT, FILE_NAME)


def _blank() -> dict[str, Any]:
    return {"version": VERSION, "providers": {}, "runtime": {}}


def load(*, strict: bool = False) -> dict[str, Any]:
    """Read the record; writers refuse to replace an unreadable file.

    A read failure defaults providers ON. That is the safe degradation: a
    damaged preference must not make every org suddenly lose its hire lanes.
    Mutations use ``strict=True`` so the same damage cannot be silently
    replaced with a blank document.
    """
    with _LOCK:
        try:
            with open(path(), encoding="utf-8") as f:
                doc: Any = json.load(f)
        except FileNotFoundError:
            return _blank()
        except (OSError, json.JSONDecodeError) as e:
            if strict:
                raise AppSettingsUnreadable(
                    f"{path()} exists but could not be read ({e}) — refusing "
                    "to overwrite it") from None
            return _blank()
        if not isinstance(doc, dict) or doc.get("version") != VERSION:
            if strict:
                raise AppSettingsUnreadable(
                    f"{path()} is not an app-settings version {VERSION} "
                    "document — refusing to overwrite it")
            return _blank()
        raw = doc.get("providers")
        doc["providers"] = raw if isinstance(raw, dict) else {}
        runtime = doc.get("runtime")
        doc["runtime"] = runtime if isinstance(runtime, dict) else {}
        return doc


def provider_enabled(provider: str) -> bool:
    """The user's machine-wide choice. Only explicit ``False`` turns it off."""
    raw = load().get("providers")
    return not (isinstance(raw, dict) and raw.get(provider) is False)


def provider_choices() -> dict[str, bool]:
    """All known providers, including the default-on values."""
    raw = load().get("providers")
    prefs = raw if isinstance(raw, dict) else {}
    return {provider: prefs.get(provider) is not False for provider in PROVIDERS}


def working_checkups_enabled() -> bool:
    """Whether reported-working seats get real 20-minute checkup turns.

    Only an explicit false disables it. This is both the compatibility rule
    for records written before the setting existed and the product default.
    """
    raw = load().get("runtime")
    runtime = raw if isinstance(raw, dict) else {}
    return runtime.get("working_checkups") is not False


def idle_docket_reminders_enabled() -> bool:
    """Whether idle seats holding unfinished owned docket items are nudged.

    Only an explicit true enables it. A newly added optional wake must not
    start spending turns on installs that never asked for it, so absence is
    off — the opposite compatibility rule from working checkups, which
    existed before its setting did.
    """
    raw = load().get("runtime")
    runtime = raw if isinstance(raw, dict) else {}
    return runtime.get("idle_docket_reminders") is True


def wait_for_mcp_tools_enabled() -> bool:
    """Whether turns wait for the last authoritative MCP tool surface.

    This is an admission-latency choice, so only explicit true enables it.
    Missing remains false for compatibility with every pre-setting install.
    """
    raw = load().get("runtime")
    runtime = raw if isinstance(raw, dict) else {}
    return runtime.get("wait_for_mcp_tools") is True


def git_periodic_fetch_enabled() -> bool:
    """Only an explicit app-wide opt-in fetches open repositories periodically."""
    return load()["runtime"].get("git_periodic_fetch") is True


def set_git_periodic_fetch_enabled(enabled: bool) -> None:
    with _LOCK:
        doc = load(strict=True)
        doc["runtime"]["git_periodic_fetch"] = bool(enabled)
        _save(doc)


def _save(doc: dict[str, Any]) -> None:
    blob = json.dumps(doc, indent=2).encode("utf-8")
    target = path()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        for attempt in range(20):
            try:
                os.replace(tmp, target)
                tmp = ""
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.01 * (attempt + 1))
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


def set_provider_enabled(provider: str, enabled: bool) -> None:
    if provider not in PROVIDERS:
        raise ValueError(f"unknown provider {provider!r}")
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("providers")
        prefs: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        # Store both values explicitly. Missing still means enabled for old
        # installs; an explicit true proves a successful round trip in the
        # preferences screen rather than relying on absence as success.
        prefs[provider] = bool(enabled)
        doc["providers"] = prefs
        doc["version"] = VERSION
        _save(doc)


def set_working_checkups_enabled(enabled: bool) -> None:
    """Persist the machine-wide checkup/cache-read lifecycle choice."""
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("runtime")
        runtime: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        runtime["working_checkups"] = bool(enabled)
        doc["runtime"] = runtime
        doc["version"] = VERSION
        _save(doc)


def set_idle_docket_reminders_enabled(enabled: bool) -> None:
    """Persist the machine-wide idle docket reminder choice."""
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("runtime")
        runtime: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        runtime["idle_docket_reminders"] = bool(enabled)
        doc["runtime"] = runtime
        doc["version"] = VERSION
        _save(doc)


def set_wait_for_mcp_tools_enabled(enabled: bool) -> None:
    """Persist the machine-wide MCP-readiness admission choice."""
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("runtime")
        runtime: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        runtime["wait_for_mcp_tools"] = bool(enabled)
        doc["runtime"] = runtime
        doc["version"] = VERSION
        _save(doc)
