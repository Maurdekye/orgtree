"""Long-lived account tokens — stored SEPARATELY from the identity registry.

    `accounts.py` records WHO this install may bill and never HOW. That
    invariant is enforced there by a guard that refuses credential-shaped
    values and keys, and **this module does not relax it**. Tokens live in
    their own file, are never merged into `accounts.json`, and never appear in
    `accounts.readout()` or any API response.

WHY A SEPARATE FILE AND NOT A FIELD (user decision 2026-08-24)
-------------------------------------------------------------
A field on the account record would mean the registry's own guard had to be
loosened to let credential-shaped values through — and that guard is the only
thing standing between a token and the file the panel serialises. Splitting the
storage keeps the guard intact and keeps it protecting the object it was
written for.

⚠ STORE FIRST, VALIDATE AFTER. The CLI says of a minted token: *"Store this
token securely. You won't be able to see it again."* There is exactly ONE
copy and no way to re-read it. So `put()` performs the write BEFORE anything
can reject the value: a validation failure that discarded the only copy would
cost the user a re-mint AND another account-switch hazard window. Callers
validate afterwards, against what is already durable.

⚠ NOTHING HERE MAY BE LOGGED, RETURNED OVER HTTP, OR PUT IN MAIL. `redacted()`
is the only thing safe to display. The tier hazard is real on this machine:
credential material in mail has repeatedly destroyed sessions, and the trigger
is the SUBJECT, not the value.
"""
from __future__ import annotations

import json
import os
import threading
from typing import Any

from . import store

VERSION = 1
_LOCK = threading.RLock()


def tokens_path() -> str:
    """Resolved from `store.DATA_ROOT` at CALL time, never cached and never
    read from os.environ — a test that moves the data root must move this with
    it, or it is testing the developer's real file."""
    return os.path.join(store.DATA_ROOT, "account_tokens.json")


def _blank() -> dict[str, Any]:
    return {"version": VERSION, "tokens": {}}


def load() -> dict[str, Any]:
    """Readers degrade to blank rather than raising: a missing or corrupt
    token file must not take the panel or the turn loop down. A WRITE against
    a corrupt file is refused separately (see `put`) so that degrading to
    blank can never blank the file."""
    try:
        with open(tokens_path(), encoding="utf-8") as f:
            doc = json.load(f)
    except Exception:                                        # noqa: BLE001
        return _blank()
    if not isinstance(doc, dict) or not isinstance(doc.get("tokens"), dict):
        return _blank()
    return doc


def _load_strict() -> dict[str, Any]:
    """For WRITERS. Raises rather than degrading, so a corrupt or
    future-version file is never silently overwritten with a blank one —
    the data-loss shape `accounts.py` was fixed for."""
    if not os.path.exists(tokens_path()):
        return _blank()
    with open(tokens_path(), encoding="utf-8") as f:
        doc = json.load(f)                     # raises on corrupt
    if not isinstance(doc, dict) or not isinstance(doc.get("tokens"), dict):
        raise ValueError("token store is malformed; refusing to overwrite")
    if int(doc.get("version") or 0) > VERSION:
        raise ValueError(f"token store is version {doc.get('version')}, "
                         f"newer than this code ({VERSION}); refusing to write")
    return doc


def put(uuid: str, token: str) -> None:
    """⚠ STORE FIRST. Writes the token durably before any validation runs.

    Only the two things that make the write meaningless are checked, and both
    are checked BEFORE the write rather than after it because neither can be
    recovered from: an empty uuid has nowhere to go, and an empty token is not
    a credential."""
    uuid = str(uuid or "").strip()
    if not uuid:
        raise ValueError("uuid is required")
    if not str(token or "").strip():
        raise ValueError("refusing to store an empty token")
    with _LOCK:
        doc = _load_strict()
        doc["tokens"][uuid] = token
        doc["version"] = VERSION
        os.makedirs(os.path.dirname(tokens_path()), exist_ok=True)
        tmp = tokens_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
        os.replace(tmp, tokens_path())          # atomic; no partial file


def get(uuid: str) -> str:
    """The raw token, or "" — the ONLY function that returns the secret.
    Callers: the spawn seam. Nothing else."""
    if not uuid:
        return ""
    return str(load()["tokens"].get(str(uuid)) or "")


def has(uuid: str) -> bool:
    return bool(get(uuid))


def forget(uuid: str) -> bool:
    with _LOCK:
        doc = _load_strict()
        if str(uuid) not in doc["tokens"]:
            return False
        del doc["tokens"][str(uuid)]
        tmp = tokens_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
        os.replace(tmp, tokens_path())
        return True


def redacted() -> dict[str, str]:
    """The ONLY shape safe to display, log, or return over HTTP: which
    accounts have a token, and nothing whatsoever about its value — not a
    prefix, not a suffix, not a length. Length is a real disclosure and it
    buys a reader nothing they need."""
    return {uuid: "stored" for uuid in sorted(load()["tokens"])}
