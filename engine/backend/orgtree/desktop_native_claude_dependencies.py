"""Copy the native tool-output layout whose references are explicit file paths.

Flat native subagent transcripts share the parent's independent resume
directory. File-rewind backups and unknown layouts remain held.
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
    subagents: dict[Path, list[dict]] = {}
    if sidecars.exists():
        if not sidecars.is_dir():
            raise NativeHeld("Native session sidecars are not a directory")
        for child in sidecars.iterdir():
            _plain(child)
            if child.name not in {"tool-results", "subagents"} or not child.is_dir():
                raise NativeHeld("Native session sidecars have an unsupported layout")
            for item in child.iterdir():
                _plain(item)
                if not item.is_file():
                    raise NativeHeld("Nested native session sidecars are not supported")
                if child.name == "subagents":
                    from .desktop_native import _read_native, claude_records
                    match = re.fullmatch(r"agent-([A-Za-z0-9_-]{1,160})\.jsonl", item.name)
                    if not match:
                        raise NativeHeld("Native subagent sidecars require a verified filename/layout")
                    agent = match.group(1)
                    records, _ = _read_native(item)
                    if any(row.get("agentId") not in {None, agent} for row in records):
                        raise NativeHeld("Native subagent identity disagrees with its filename")
                    if not any(row.get("isSidechain") is True for row in records):
                        raise NativeHeld("Native subagent sidecars have no native sidechain identity")
                    cwd = next((row["cwd"] for row in rows if isinstance(row.get("cwd"), str)), str(destination))
                    subagents[item] = claude_records(records, source_sid, destination.name, cwd)
                files.append(item)
                if len(files) > 4096:
                    raise NativeHeld("Native tool-output file count exceeds import limit")
    if sum(p.stat().st_size for p in files) > MAX_NATIVE_BYTES:
        raise NativeHeld("Native tool-output bytes exceed import limit")
    mapping = {str(p).replace("\\", "/"): str(destination / p.parent.name / p.name) for p in files}
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
        explicit = key == "persistedOutputPath" and bool(value)
        if explicit and not any(re.fullmatch(re.escape(str(p).replace("\\", "/")), normalized, flags)
                                for p in files if p.parent.name == "tool-results"):
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
        for match in re.finditer(r"/(?:tool-results|subagents)/", folded):
            if not any(start <= match.start() < end for start, end in spans):
                raise NativeHeld("Native context mixes copied and unavailable tool-output sidecars")
        if ("/tool-results/" in folded or "<persisted-output>" in folded) and not changed:
            raise NativeHeld("Native context references an unavailable tool-output sidecar")
        return result if changed else value
    copied = rewrite(rows)
    rewritten_subagents = {path: rewrite(records) for path, records in subagents.items()}
    if staging is not None and files:
        for source in files:
            target = staging / source.parent.name
            target.mkdir(parents=True, exist_ok=True)
            if source in rewritten_subagents:
                import json
                with (target / source.name).open("xb") as stream:
                    for row in rewritten_subagents[source]:
                        stream.write((json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
                    stream.flush()
                    os.fsync(stream.fileno())
            else:
                _copy_file(source, target / source.name)
    return copied
