"""One run of tools/p02_operation_contacts.py per suite run, shared by the modules that read it.

tests/test_p02_operation_contacts.py and tests/test_state_p02_contact_facets.py
both assert over the same probe output, and each used to run the probe itself
(~50 s apiece). They run in separate interpreters, so the result is shared on
disk -- but only WITHIN ONE RUN of tools/run-python-verification.py: the runner
gives every module ORGTREE_DATA=<run root>/<uuid>, so the first module to ask
runs the probe and leaves its output in the run root, and the runner deletes
the run root when the run ends. Every suite run therefore still executes the
probe exactly once, nothing outlives the run, and a module run on its own (or
outside the runner) simply runs the probe itself as before.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "tools" / "p02_operation_contacts.py"
OUTPUTS = ("operation-contacts.json", "operation-contacts.md")


def _run_probe(out: Path) -> None:
    proc = subprocess.run([sys.executable, "-I", "-B", str(TOOL), "--out", str(out)],
                          capture_output=True, text=True, timeout=1200)
    if proc.returncode != 0:
        raise AssertionError(f"probe exited {proc.returncode}: {proc.stderr[-3000:]}")


def _read(folder: Path) -> tuple[dict, str]:
    return (json.loads((folder / OUTPUTS[0]).read_text(encoding="utf-8")),
            (folder / OUTPUTS[1]).read_text(encoding="utf-8"))


def probe_output(tmp_parent: str | None = None) -> tuple[dict, str]:
    """The probe's (operation-contacts.json as a dict, operation-contacts.md)."""
    with tempfile.TemporaryDirectory(prefix="p02-contacts-probe-", dir=tmp_parent) as tmp:
        if not (os.environ.get("ORGTREE_VERIFY_MODULE") and os.environ.get("ORGTREE_DATA")):
            _run_probe(Path(tmp) / "out")
            return _read(Path(tmp) / "out")
        shared = Path(os.environ["ORGTREE_DATA"]).parent / "p02-contacts-probe"
        if not (shared / OUTPUTS[0]).exists():
            _run_probe(Path(tmp) / "out")
            staged = shared.parent / f".p02-contacts-probe-{uuid.uuid4().hex}"
            staged.mkdir()
            for name in OUTPUTS:
                shutil.copyfile(Path(tmp) / "out" / name, staged / name)
            try:
                os.replace(staged, shared)
            except OSError:
                # another module of the same run published first; same tree, same probe
                shutil.rmtree(staged, ignore_errors=True)
        try:
            return _read(shared)
        except (OSError, ValueError):
            # a partial or unreadable entry is never a verdict: run it here
            _run_probe(Path(tmp) / "own")
            return _read(Path(tmp) / "own")
