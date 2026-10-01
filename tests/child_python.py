"""Start a child Python that provably imports THIS checkout's engine.

A test that starts ``sys.executable`` and hands it ``PYTHONPATH`` -- or relies
on ``cwd``, or on the script's own folder -- does not get the checkout it
thinks it gets.  ``engine/runtime/`` is gitignored, so in a worktree
``sys.executable`` is the MAIN checkout's interpreter, and its
``python313._pth``:

* makes the interpreter ignore the environment, so ``PYTHONPATH`` is dropped
  (``sys.flags.ignore_environment == 1`` with or without ``-I``);
* puts neither ``cwd`` nor a script's folder on ``sys.path``;
* lists ``../backend`` and ``../../`` -- the MAIN checkout's ``engine/backend``
  and root -- so ``import orgtree``, ``import engine`` and ``-m tools.x``
  quietly resolve to the main checkout instead of failing.

The parent test's ``import_provenance`` is correct, so the runner's receipt
cannot show it.  The child tests the wrong tree and reports a plausible result.

Usage -- build the argv, keep everything else about the call::

    import child_python
    subprocess.run(child_python.argv('-c', code, arg1), env=env, ...)
    subprocess.run(child_python.argv(str(script), 'seed', flags=('-B',)), ...)
    subprocess.run(child_python.argv('-m', 'tools.migration_harness', ...), ...)

The child puts this checkout's roots first on ``sys.path``, then checks where
``orgtree`` and ``engine`` resolve -- with ``find_spec``, which does not run
them, so a child that asserts an import is REFUSED (devguard) still works --
and exits with ``EXIT_FOREIGN`` and a message on stderr if either resolves
outside the checkout.  It checks again when the child finishes, against the
modules it actually imported.  Then it runs the ``-c`` code, ``-m`` module or
script exactly as ``python`` would, with the same ``sys.argv``.

Scripts outside the checkout that cannot import this module by name load it by
path (``importlib.util.spec_from_file_location``); see
``tests/acceptance/seed_history_fixture.py``.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

__all__ = ["CHECKOUT", "EXIT_FOREIGN", "GUARDED", "BOOT", "roots", "argv"]

# The helper sits at <checkout>/tests/, so its own location IS the checkout.
CHECKOUT = Path(__file__).resolve().parents[1]
GUARDED = ("orgtree", "engine")
# Distinct from any status a test child uses on purpose, so a refusal cannot
# be mistaken for the child's own failure.
EXIT_FOREIGN = 97

BOOT = r'''
import importlib.util as _u, json as _j, os as _o, runpy as _r, sys as _s
_checkout = _o.path.normcase(_o.path.realpath(_s.argv[1]))
_roots, _guarded, _code = _j.loads(_s.argv[2]), _j.loads(_s.argv[3]), int(_s.argv[4])
_rest = _s.argv[5:]
_s.path[:0] = _roots
def _origin(name):
    mod = _s.modules.get(name)
    if mod is not None:
        where = getattr(mod, "__file__", None) or next(iter(getattr(mod, "__path__", ()) or ()), None)
    else:
        try:
            spec = _u.find_spec(name)
        except (ImportError, ValueError):
            spec = None
        if spec is None:
            return None
        where = spec.origin or next(iter(spec.submodule_search_locations or ()), None)
    return where and _o.path.normcase(_o.path.realpath(where))
def _check(when):
    for name in _guarded:
        where = _origin(name)
        if where and not (where == _checkout or where.startswith(_checkout + _o.sep)):
            _s.stderr.write("child_python: %s resolved OUTSIDE the checkout under test %s: %s "
                            "(checkout under test: %s). This child would test the wrong tree.\n"
                            % (name, when, where, _checkout))
            _s.stderr.flush()
            _o._exit(_code)
_check("before the child ran")
try:
    if _rest[0] == "-c":
        _s.argv = ["-c", *_rest[2:]]
        exec(compile(_rest[1], "<string>", "exec"), globals())
    elif _rest[0] == "-m":
        _s.argv = [_rest[1], *_rest[2:]]
        _r.run_module(_rest[1], run_name="__main__", alter_sys=True)
    else:
        _s.argv = list(_rest)
        _s.path.insert(0, _o.path.dirname(_o.path.abspath(_rest[0])))
        _r.run_path(_rest[0], run_name="__main__")
finally:
    _check("by the time the child finished")
'''


def roots(checkout: Path | str = CHECKOUT, extra: tuple = ()) -> list[str]:
    """The import roots a child gets: the engine backend, then the checkout
    itself (for ``engine`` and ``tools``), then any ``extra`` paths."""
    checkout = Path(checkout).resolve()
    return [str(checkout / "engine" / "backend"), str(checkout), *(str(p) for p in extra)]


def argv(*args: str, checkout: Path | str = CHECKOUT, flags: tuple = (), extra_roots: tuple = (),
         guarded: tuple = GUARDED, python: str | None = None) -> list[str]:
    """``[python, *flags, '-c', BOOT, ...]`` that runs ``args`` -- ``'-c', code,
    *argv``, ``'-m', module, *argv`` or ``script, *argv`` -- against
    ``checkout``'s engine, refusing (exit ``EXIT_FOREIGN``) if it resolves
    anywhere else."""
    if not args:
        raise ValueError("child_python.argv needs '-c' code, '-m' module or a script")
    if args[0] in ("-c", "-m") and len(args) < 2:
        raise ValueError(f"child_python.argv: {args[0]} needs an argument")
    checkout = Path(checkout).resolve()
    return [python or sys.executable, *flags, "-c", BOOT, str(checkout),
            json.dumps(roots(checkout, extra_roots)), json.dumps(list(guarded)),
            str(EXIT_FOREIGN), *map(str, args)]
