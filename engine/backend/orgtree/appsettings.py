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
checkups and idle docket reminders are default-on; the readiness gate is
deliberately default-off so existing installs preserve today's no-wait turn
startup unless the operator opts in.
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
#: the metered API-key lanes (user redesign 2026-09-12): the providers whose
#: accounts can be pasted API keys. Google is absent on purpose — no API-key
#: login exists for it (measured 1.1.24).
APIKEY_PROVIDERS: Final = frozenset({"claude", "openai"})
#: the subscription-inference switch covers every CLI provider with a
#: subscription login to disable; openrouter is a bearer-key lane and has
#: no subscription half.
SUBSCRIPTION_PROVIDERS: Final = frozenset({"claude", "openai", "google"})
_LOCK = threading.RLock()


class AppSettingsUnreadable(RuntimeError):
    """An existing settings record cannot be safely read or overwritten."""


def path() -> str:
    """Resolve per call: tests replace store.DATA_ROOT after module import."""
    return os.path.join(store.DATA_ROOT, FILE_NAME)


def _blank() -> dict[str, Any]:
    return {"version": VERSION, "providers": {}, "runtime": {},
            "apikey_fallback": {}, "subscription_inference": {}}


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
        for field in ("apikey_fallback", "subscription_inference"):
            section = doc.get(field)
            doc[field] = section if isinstance(section, dict) else {}
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


def apikey_fallback_enabled(provider: str) -> bool:
    """The machine-wide API-key fallback consent for one provider — may
    routing spend this provider's ENABLED key accounts once every applicable
    subscription limit is exhausted? DEFAULT OFF (ticket requirement): only
    an explicit saved true routes anything to a metered key, so an install
    upgrade can never start billing a key on the absence of a record."""
    raw = load().get("apikey_fallback")
    return isinstance(raw, dict) and raw.get(provider) is True


def apikey_fallback_choices() -> dict[str, bool]:
    """Every API-key-capable provider's fallback consent, defaults applied."""
    raw = load().get("apikey_fallback")
    prefs = raw if isinstance(raw, dict) else {}
    return {p: prefs.get(p) is True for p in sorted(APIKEY_PROVIDERS)}


def subscription_inference_enabled(provider: str) -> bool:
    """Whether this provider's signed-in subscription accounts may serve
    turns at all. Only an explicit false disables — missing keeps every
    existing install routing subscriptions exactly as before."""
    raw = load().get("subscription_inference")
    return not (isinstance(raw, dict) and raw.get(provider) is False)


def subscription_inference_choices() -> dict[str, bool]:
    """Every subscription provider's inference choice, defaults applied."""
    raw = load().get("subscription_inference")
    prefs = raw if isinstance(raw, dict) else {}
    return {p: prefs.get(p) is not False
            for p in sorted(SUBSCRIPTION_PROVIDERS)}


def set_apikey_fallback_enabled(provider: str, enabled: bool) -> None:
    """Persist one provider's machine-wide API-key fallback consent."""
    if provider not in APIKEY_PROVIDERS:
        raise ValueError(
            f"{provider!r} has no API-key account lane — the fallback "
            f"switch exists for {', '.join(sorted(APIKEY_PROVIDERS))}")
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("apikey_fallback")
        prefs: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        prefs[provider] = bool(enabled)
        doc["apikey_fallback"] = prefs
        doc["version"] = VERSION
        _save(doc)


def set_subscription_inference_enabled(provider: str, enabled: bool) -> None:
    """Persist one provider's machine-wide subscription-inference choice."""
    if provider not in SUBSCRIPTION_PROVIDERS:
        raise ValueError(
            f"{provider!r} has no subscription lane to disable — the switch "
            f"exists for {', '.join(sorted(SUBSCRIPTION_PROVIDERS))}")
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("subscription_inference")
        prefs: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        prefs[provider] = bool(enabled)
        doc["subscription_inference"] = prefs
        doc["version"] = VERSION
        _save(doc)


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

    Only an explicit false disables it. Missing remains enabled for installs
    that predate this preference, while an explicit saved false is preserved.
    """
    raw = load().get("runtime")
    runtime = raw if isinstance(raw, dict) else {}
    return runtime.get("idle_docket_reminders") is not False


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
