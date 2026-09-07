"""Copy the native tool-output layout whose references are explicit file paths.

File-rewind backups, subagent sessions and unknown layouts remain held until
their provider-native restoration has its own verified import path.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
from typing import Any

from .desktop_native import MAX_NATIVE_BYTES, NativeHeld


def copy_outputs(path: Path, source_sid: str, rows: list[dict],
                 destination: Path, staging: Path | None = None) -> list[dict]:
    from .desktop_import import _copy_file, _plain
    sidecars = path.parent / source_sid
    _plain(sidecars)
    files: list[Path] = []
    if sidecars.exists():
        if not sidecars.is_dir():
            raise NativeHeld("Native session sidecars are not a directory")
        for child in sidecars.iterdir():
            _plain(child)
            if child.name != "tool-results" or not child.is_dir():
                raise NativeHeld("Native session sidecars other than tool-results need a verified clone")
            for item in child.iterdir():
                _plain(item)
                if not item.is_file():
                    raise NativeHeld("Nested native tool-output sidecars are not supported")
                files.append(item)
                if len(files) > 4096:
                    raise NativeHeld("Native tool-output file count exceeds import limit")
    if sum(p.stat().st_size for p in files) > MAX_NATIVE_BYTES:
        raise NativeHeld("Native tool-output bytes exceed import limit")
    mapping = {str(p).replace("\\", "/"): str(destination / "tool-results" / p.name) for p in files}
    flags = re.IGNORECASE if os.name == "nt" else 0
    def rewrite(value: Any, key: str = "") -> Any:
        if key == "backupFileName" and value:
            raise NativeHeld("Native file-history sidecar needs a verified clone")
        if isinstance(value, dict):
            return {k: rewrite(v, k) for k, v in value.items()}
        if isinstance(value, list):
            return [rewrite(v) for v in value]
        if not isinstance(value, str):
            if key == "persistedOutputPath" and value:
                raise NativeHeld("Native persisted output path is invalid")
            return value
        normalized = value.replace("\\", "/")
        folded = normalized.lower()
        if "/subagents/" in folded:
            raise NativeHeld("Native subagent sidecar needs a verified clone")
        explicit = key == "persistedOutputPath" and bool(value)
        if explicit and not any(re.fullmatch(re.escape(src), normalized, flags) for src in mapping):
            raise NativeHeld("Native persisted output is missing or outside the selected session")
        changed, spans, result = False, [], value
        for src, target in mapping.items():
            # Require a path boundary after a filename: a.txt must not rewrite
            # a.txt.secret or a.txt/child into a plausible destination path.
            pattern = re.escape(src) + r'(?=$|[\s<>"\x27])'
            spans.extend(match.span() for match in re.finditer(pattern, normalized, flags))
            flexible = r'[\\/]'.join(re.escape(part) for part in src.split('/')) + r'(?=$|[\s<>"\x27])'
            result, count = re.subn(flexible, lambda _: target, result, flags=flags)
            changed = changed or bool(count)
        for match in re.finditer("/tool-results/", folded):
            if not any(start <= match.start() < end for start, end in spans):
                raise NativeHeld("Native context mixes copied and unavailable tool-output sidecars")
        if ("/tool-results/" in folded or "<persisted-output>" in folded) and not changed:
            raise NativeHeld("Native context references an unavailable tool-output sidecar")
        return result if changed else value
    copied = rewrite(rows)
    if staging is not None and files:
        target = staging / "tool-results"
        target.mkdir(parents=True)
        for source in files:
            _copy_file(source, target / source.name)
    return copied
