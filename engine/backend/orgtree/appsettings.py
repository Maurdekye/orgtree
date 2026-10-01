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
#: accounts can be pasted API keys, including the direct Gemini lane.
APIKEY_PROVIDERS: Final = frozenset({"claude", "openai", "google"})
#: the subscription-inference switch covers every CLI provider with a
#: subscription login to disable; openrouter is a bearer-key lane and has
#: no subscription half.
SUBSCRIPTION_PROVIDERS: Final = frozenset({"claude", "openai", "google"})
_LOCK = threading.RLock()
QUICK_STAFF_MODES: Final = ("request", "under_assignee", "top_level")


def quick_staff_behavior() -> str:
    value = load().get("runtime", {}).get("quick_staff_behavior")
    return value if value in QUICK_STAFF_MODES else "request"


def set_quick_staff_behavior(value: str) -> None:
    if value not in QUICK_STAFF_MODES:
        raise ValueError("unknown Quick staff behavior")
    with _LOCK:
        doc = load(strict=True)
        doc["runtime"]["quick_staff_behavior"] = value
        _save(doc)


def quick_staff_request_accounts() -> bool:
    """Whether Request staffing offers a suggested-account choice (the
    "Include account selection when requesting staffing" option, user
    2026-09-20). Strictly `is True` so a configuration saved before the option
    existed — or any non-boolean residue — reads as OFF, the required default.
    """
    return load().get("runtime", {}).get("quick_staff_request_accounts") is True


def set_quick_staff_request_accounts(value: bool) -> None:
    if not isinstance(value, bool):
        raise ValueError("unknown Include-account-selection value")
    with _LOCK:
        doc = load(strict=True)
        doc["runtime"]["quick_staff_request_accounts"] = value
        _save(doc)


def openrouter_harness() -> str:
    """Which CLI a NEWLY HIRED OpenRouter agent is given (user ruling
    2026-09-19).

    ⚠ A DEFAULT FOR NEW HIRES, NOT A LIVE SWITCH. Changing it moves nobody:
    every agent stamps its harness at hire (`ledger.Org.hire`) and keeps that
    value for its whole life. Reading it here to decide a RUNNING agent's
    launch would be the automatic migration the ticket forbids — and worse
    than a policy breach, it would silently end that agent's provider-side
    session continuity mid-life, which is the same hazard the account rules
    already refuse to take on anyone's behalf.

    Unknown or absent values read as the lane default, which is also what
    every agent hired before this setting existed is really running.
    """
    from . import openrouter_harness as _h              # noqa: PLC0415
    return _h.canonical(load().get("runtime", {}).get("openrouter_harness"))


def set_openrouter_harness(value: str) -> None:
    from . import openrouter_harness as _h              # noqa: PLC0415
    if value not in _h.HARNESSES:
        raise ValueError(
            f"unknown OpenRouter harness {value!r}; know "
            f"{', '.join(_h.HARNESSES)}")
    with _LOCK:
        doc = load(strict=True)
        doc["runtime"]["openrouter_harness"] = value
        _save(doc)


#: Bounds on the charter template directory list (docket
#: add-external-agent-charter-templates-folder). Generous for a hand-kept list
#: of folders; they exist so one malformed request cannot store an unbounded
#: record that every hire form then scans.
CHARTER_TEMPLATE_DIRS_MAX: Final = 32
CHARTER_TEMPLATE_DIR_CHARS: Final = 1024


def _canonical_template_dir(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("charter template directories must be text paths")
    text = value.strip()
    if not text:
        raise ValueError("a charter template directory path may not be blank")
    if len(text) > CHARTER_TEMPLATE_DIR_CHARS or "\x00" in text:
        raise ValueError("charter template directory path is not a usable path")
    if not os.path.isabs(text):
        raise ValueError(f"charter template directories must be absolute paths: {text}")
    return os.path.normpath(text)


def _refuse_invalid_path_syntax(path: str) -> None:
    """Refuse a path the OS rejects as SYNTAX (Windows ERROR_INVALID_NAME,
    e.g. a component holding `<` or a second `:`). A folder that is merely
    missing, on an absent drive or an unreachable share is still accepted —
    the reader reports those — and nothing is created. Only on save: the
    reader must never touch the filesystem to list the setting."""
    try:
        os.lstat(path)
    except ValueError as exc:
        raise ValueError(f"not a usable folder path: {path} ({exc})") from None
    except OSError as exc:
        if getattr(exc, "winerror", None) == 123:
            raise ValueError(f"not a usable folder path: {path}") from None


def charter_template_dirs() -> list[str]:
    """The machine-wide, ordered list of external charter template folders.

    Only the paths are stored; nothing is read, created or checked here, so a
    folder that is missing today is kept and reported by the reader rather
    than silently forgotten. Malformed residue in the record is skipped.
    """
    raw = load().get("runtime", {}).get("charter_template_dirs")
    out: list[str] = []
    for entry in raw if isinstance(raw, list) else []:
        try:
            out.append(_canonical_template_dir(entry))
        except ValueError:
            continue
    return out[:CHARTER_TEMPLATE_DIRS_MAX]


def set_charter_template_dirs(values: list[str]) -> list[str]:
    """Replace the whole ordered list. Order is meaningful — it is the
    precedence between templates with the same name — so the list is stored
    as given, after normalising each path; a repeated folder is refused rather
    than silently collapsed so the caller never loses track of an entry."""
    if not isinstance(values, list):
        raise ValueError("charter template directories must be a list")
    if len(values) > CHARTER_TEMPLATE_DIRS_MAX:
        raise ValueError(
            f"at most {CHARTER_TEMPLATE_DIRS_MAX} charter template directories")
    dirs = [_canonical_template_dir(v) for v in values]
    for d in dirs:
        _refuse_invalid_path_syntax(d)
    seen: set[str] = set()
    for d in dirs:
        key = os.path.normcase(d)
        if key in seen:
            raise ValueError(f"charter template directory listed twice: {d}")
        seen.add(key)
    with _LOCK:
        doc = load(strict=True)
        doc["runtime"]["charter_template_dirs"] = dirs
        _save(doc)
    return dirs


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
    # this switch decides whether a provider lane can be hired on at all, so
    # the warm staffing snapshot is now wrong about which models are offered
    from . import registry
    registry.availability_changed("apikey_fallback preference changed")


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
    # this switch decides whether a provider lane can be hired on at all, so
    # the warm staffing snapshot is now wrong about which models are offered
    from . import registry
    registry.availability_changed("subscription_inference preference changed")


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


def blocked_docket_reminders_enabled() -> bool:
    """Whether an agent may also be reminded about its BLOCKED docket items,
    in the one case where the whole organization is blocked.

    DEFAULT OFF, and only an explicit true enables it (user 2026-09-13, who
    asked for the rule behind a toggle because its long-term implications are
    not yet known). Missing therefore remains OFF, which is also the
    compatible reading for every install that predates the preference.

    The option is PURELY ADDITIVE. Off, the reminder behaves exactly as it
    always has: an idle agent is nudged about its actionable owned items and
    blocked ones are excluded per item. On, that is unchanged — actionable
    work is still reminded about exactly as before — and the single addition
    is that when the organization's entire remaining nonterminal set is
    blocked, each agent is reminded of its own blocked items instead of
    hearing nothing. It never withholds a reminder that would otherwise be
    sent.
    """
    raw = load().get("runtime")
    runtime = raw if isinstance(raw, dict) else {}
    return runtime.get("blocked_docket_reminders_enabled") is True


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


#: bounds of the machine-wide concurrent-turn limit (user ruling 2026-09-26:
#: a SETTING, default 16). The scheduler itself is turnslots.FairSlots.
MAX_TURNS_MIN: Final = 1
MAX_TURNS_MAX: Final = 512


def max_concurrent_turns() -> int | None:
    """The stored machine-wide limit on concurrent agent turns, or None when
    the user never set one (the caller then falls back to ORGTREE_MAX_TURNS,
    then to 16). A stored value outside the bounds reads as unset rather than
    being silently clamped into something the user did not choose."""
    raw = load().get("runtime")
    runtime = raw if isinstance(raw, dict) else {}
    value = runtime.get("max_concurrent_turns")
    if type(value) is int and MAX_TURNS_MIN <= value <= MAX_TURNS_MAX:
        return value
    return None


def set_max_concurrent_turns(limit: int) -> None:
    """Persist the machine-wide concurrent-turn limit (refuses out of range)."""
    if type(limit) is not int or not MAX_TURNS_MIN <= limit <= MAX_TURNS_MAX:
        raise ValueError(f"max_concurrent_turns must be an integer from "
                         f"{MAX_TURNS_MIN} to {MAX_TURNS_MAX}")
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("runtime")
        runtime: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        runtime["max_concurrent_turns"] = limit
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


def set_blocked_docket_reminders_enabled(enabled: bool) -> None:
    """Persist the machine-wide all-blocked docket reminder gate choice."""
    with _LOCK:
        doc = load(strict=True)
        raw = doc.get("runtime")
        runtime: dict[str, Any] = dict(raw) if isinstance(raw, dict) else {}
        runtime["blocked_docket_reminders_enabled"] = bool(enabled)
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
