"""Assert that the engine under test came from THIS checkout.

An agent CLI is spawned BY the installed Orgtree engine, which prepends its own
backend to ``PYTHONPATH`` so the child can import it (``supervisor.py``,
``warmpool.py``, ``antigravity_session.py``).  That injection is correct and
must not be removed — agent spawning depends on it.  Its unintended reach is
this: every command the agent then types inherits a ``PYTHONPATH`` pointing at
the SHIPPED backend, ahead of the checkout.  It is NOT a machine-wide setting;
the Machine and User scopes are empty, so a reader who checks the registry finds
nothing.

A Python test module launched with a bare ``python`` therefore imports the
installed build instead of the working tree, and nothing in the output says so.
The loud direction wastes hours on failures that belong to shipped code; the
quiet direction is worse -- a green run reported as a verified fix against a
module that never contained the change.

The sanctioned runner, ``tools/run-python-verification.py``, launches every
module with ``-I`` (isolated mode ignores ``PYTHONPATH``) and puts this
checkout's roots on ``sys.path`` explicitly, so under it this check always
passes and costs two ``find_spec`` calls once per process.

This module runs the check on import, so ``import import_provenance`` is the
whole of the per-module contract.  See ``tests/__init__.py`` for why the flat
import works in every invocation mode.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

__all__ = ["ForeignImportError", "CHECKOUT_ROOT", "GUARDED", "assert_repo_import", "origin_of"]

# The helper sits at <checkout>/tests/, so its own location IS the checkout —
# in a linked worktree that is the worktree, which is the tree the agent edited
# and the tree whose result they are about to believe.
CHECKOUT_ROOT = Path(__file__).resolve().parents[1]

# Both roots the sanctioned runner makes visible: the engine package itself and
# the top-level ``engine`` package that the launcher and service host live in.
GUARDED = ("orgtree", "engine")

RUNNER = "python tools/run-python-verification.py"


class ForeignImportError(ImportError):
    """An engine package resolved to a path outside this checkout."""


def _normal(path: object) -> str:
    """Case-fold and resolve for comparison; Windows paths differ in case."""
    return os.path.normcase(os.path.realpath(os.path.abspath(str(path))))


def _within(path: object, root: Path) -> bool:
    candidate, parent = _normal(path), _normal(root)
    return candidate == parent or candidate.startswith(parent + os.sep)


def origin_of(name: str) -> str | None:
    """Where ``name`` DID come from, or failing that where it WOULD come from.

    An already-imported package is authoritative — that is the code the module
    is actually running against.  Otherwise the prospective resolution is what
    the module's own ``import`` is about to get.  ``None`` means the package is
    not importable at all, which is not this guard's problem: the module's own
    import will raise ``ModuleNotFoundError``, which is already loud.
    """
    imported = sys.modules.get(name)
    origin = getattr(imported, "__file__", None) if imported is not None else None
    if origin:
        return origin
    if imported is not None:
        # A namespace package has no __file__ but does have search locations.
        return next(iter(getattr(imported, "__path__", ()) or ()), None)
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, AttributeError, ValueError):
        return None
    if spec is None:
        return None
    return spec.origin or next(iter(spec.submodule_search_locations or ()), None)


def _module_under_test() -> str:
    """Name the test file for the message, so the fix is copy-pasteable."""
    tests_dir = CHECKOUT_ROOT / "tests"
    frame: object = sys._getframe(1)
    while frame is not None:
        path = getattr(frame, "f_globals", {}).get("__file__")
        name = Path(str(path)).name if path else ""
        if path and name.startswith("test_") and name.endswith(".py") and _within(path, tests_dir):
            return "tests/" + name
        frame = getattr(frame, "f_back", None)
    for argument in sys.argv:
        stem = Path(argument).name
        if stem.startswith("test_") and stem.endswith(".py"):
            return "tests/" + stem
        if argument.startswith("tests.test_"):
            return "tests/" + argument.split(".", 1)[1].replace(".", "/") + ".py"
    return "tests/test_<module>.py"


def _report(name: str, origin: str) -> str:
    pythonpath = os.environ.get("PYTHONPATH") or "(not set)"
    module = _module_under_test()
    return (
        f"`{name}` was imported from OUTSIDE this checkout, so this run is not "
        f"testing your working tree.\n\n"
        f"    imported from : {origin}\n"
        f"    this checkout : {CHECKOUT_ROOT}\n"
        f"    PYTHONPATH    : {pythonpath}\n\n"
        f"This process's PYTHONPATH points at the INSTALLED desktop app's backend "
        f"and a bare `python` puts it ahead of the checkout. (The engine that "
        f"spawned this CLI prepends it so the child can import the backend; it is "
        f"correct, it is not a machine-wide setting, and it is not yours to "
        f"remove.) Whatever this run reports, pass or fail, describes the shipped "
        f"build and says nothing about your change.\n\n"
        f"Run the module through the sanctioned runner instead:\n\n"
        f"    {RUNNER} {module}\n\n"
        f"It launches with -I, which ignores PYTHONPATH, and selects the bundled "
        f"engine/runtime/python.exe. `node tools/test-baseline.mjs compare` runs "
        f"the whole suite through that same runner."
    )


def assert_repo_import(*names: str) -> dict[str, str | None]:
    """Raise unless every guarded package resolves inside this checkout.

    Returns the observed origins so a caller can record provenance rather than
    infer it.  Never repairs ``sys.path``: making an unsanctioned run work is
    the same defect as the one this guards against, one step further along.
    """
    origins: dict[str, str | None] = {}
    for name in names or GUARDED:
        origin = origin_of(name)
        origins[name] = origin
        if origin is not None and not _within(origin, CHECKOUT_ROOT):
            raise ForeignImportError(_report(name, origin))
    return origins


ORIGINS = assert_repo_import()
