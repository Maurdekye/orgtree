"""Encoding-safe persistence for an agent's own breadcrumb log.

Breadcrumbs are user-authored recovery notes, not disposable UTF-8 logs.  A
PowerShell redirect can leave UTF-16 bytes behind, and a malformed existing
file must never be replaced by a best-effort rewrite.  This module reads the
bytes first, detects the encoding, and appends in that same encoding only when
the existing text is fully decodable.
"""

from __future__ import annotations

import codecs
import hashlib
import os
from typing import Final, TypedDict


MAX_NOTE_CHARS: Final = 2_000


class BreadcrumbRead(TypedDict):
    path: str
    availability: str                 # readable | missing | denied | unreadable
    encoding: str | None
    had_bom: bool
    bytes: int | None
    sha256: str | None
    text: str
    replacements: int
    detail: str


class BreadcrumbAppend(TypedDict):
    ok: bool
    path: str
    availability: str
    encoding: str | None
    had_bom: bool
    existing_bytes: int | None
    appended_bytes: int
    detail: str


def _sha(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _codec(data: bytes) -> tuple[str, str, bool]:
    if data.startswith(codecs.BOM_UTF8):
        return "utf-8-sig", "utf-8", True
    if data.startswith(codecs.BOM_UTF16_LE):
        return "utf-16", "utf-16-le", True
    if data.startswith(codecs.BOM_UTF16_BE):
        return "utf-16", "utf-16-be", True
    sample = data[:4096]
    even = sum(sample[i] == 0 for i in range(0, len(sample) - 1, 2))
    odd = sum(sample[i] == 0 for i in range(1, len(sample), 2))
    pairs = max(1, len(sample) // 2)
    if odd >= pairs * 0.4 and odd > even:
        return "utf-16-le", "utf-16-le", False
    if even >= pairs * 0.4 and even > odd:
        return "utf-16-be", "utf-16-be", False
    return "utf-8", "utf-8", False


def read(path: str) -> BreadcrumbRead:
    """Read a breadcrumb file without replacing undecodable bytes."""
    path = os.path.abspath(path)
    try:
        with open(path, "rb") as fh:
            data = fh.read()
    except FileNotFoundError:
        return {"path": path, "availability": "missing", "encoding": None,
                "had_bom": False, "bytes": None, "sha256": None, "text": "",
                "replacements": 0, "detail": "breadcrumbs.md is not present"}
    except PermissionError as exc:
        return {"path": path, "availability": "denied", "encoding": None,
                "had_bom": False, "bytes": None, "sha256": None, "text": "",
                "replacements": 0, "detail": f"breadcrumbs.md could not be read: {exc}"}
    except OSError as exc:
        return {"path": path, "availability": "unreadable", "encoding": None,
                "had_bom": False, "bytes": None, "sha256": None, "text": "",
                "replacements": 0, "detail": f"breadcrumbs.md could not be read: {exc}"}
    codec, _encode_codec, bom = _codec(data)
    try:
        text = data.decode(codec)
    except UnicodeDecodeError as exc:
        return {"path": path, "availability": "unreadable", "encoding": codec,
                "had_bom": bom, "bytes": len(data), "sha256": _sha(data),
                "text": "", "replacements": 1,
                "detail": f"breadcrumbs.md is not valid {codec}: {exc}"}
    return {"path": path, "availability": "readable", "encoding": codec,
            "had_bom": bom, "bytes": len(data), "sha256": _sha(data),
            "text": text, "replacements": 0, "detail": ""}


def append_note(path: str, note: str, *, max_chars: int = MAX_NOTE_CHARS) -> BreadcrumbAppend:
    """Append one note in the existing file encoding, or refuse safely.

    The refusal result is explicit and leaves the original bytes untouched.
    The note itself is bounded so a provider response cannot turn a recovery
    file into an unbounded prompt prefix.
    """
    raw_note = str(note or "")
    if max_chars < 1:
        raise ValueError("max_chars must be positive")
    if len(raw_note) > max_chars:
        raw_note = raw_note[:max_chars] + f"\n[NOTE TRUNCATED to {max_chars} characters]"
    prior = read(path)
    base: BreadcrumbAppend = {
        "ok": False, "path": prior["path"],
        "availability": prior["availability"], "encoding": prior["encoding"],
        "had_bom": prior["had_bom"], "existing_bytes": prior["bytes"],
        "appended_bytes": 0, "detail": prior["detail"]}
    if prior["availability"] == "missing":
        codec, encode_codec, bom = "utf-8", "utf-8", False
        text = ""
    elif prior["availability"] == "readable":
        codec = str(prior["encoding"])
        if codec == "utf-8-sig":
            encode_codec = "utf-8"
        elif codec == "utf-16" and prior["had_bom"]:
            with open(prior["path"], "rb") as fh:
                raw = fh.read(2)
            encode_codec = "utf-16-le" if raw == codecs.BOM_UTF16_LE else "utf-16-be"
        else:
            encode_codec = codec
        bom = bool(prior["had_bom"])
        text = prior["text"]
    else:
        base["detail"] = (prior["detail"] + "; append refused so existing bytes "
                           "were not replaced")
        return base
    if not raw_note:
        base.update(ok=True, detail="empty note; no bytes appended")
        return base
    separator = "" if not text or text.endswith(("\n", "\r")) else "\n"
    addition = separator + raw_note
    try:
        encoded = addition.encode(encode_codec)
    except UnicodeEncodeError as exc:
        base["detail"] = f"note cannot be encoded as {codec}: {exc}"
        return base
    try:
        os.makedirs(os.path.dirname(prior["path"]), exist_ok=True)
        with open(prior["path"], "ab") as fh:
            fh.write(encoded)
    except PermissionError as exc:
        base["detail"] = f"breadcrumbs.md append denied: {exc}"
        return base
    except OSError as exc:
        base["detail"] = f"breadcrumbs.md append failed: {exc}"
        return base
    base.update(ok=True, availability="readable", encoding=codec, had_bom=bom,
                appended_bytes=len(encoded), detail="appended in the existing encoding")
    return base
