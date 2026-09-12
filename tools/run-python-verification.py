"""Run Python verification modules with explicit provenance and isolated data.

This is deliberately a small process runner rather than a test framework.  Every
module gets a fresh interpreter process and a fresh ``ORGTREE_DATA`` directory.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence


SCHEMA = "orgtree.python-verification/v1"
SUPPORTED_MIN = (3, 10)
SUPPORTED_MAX = (4, 0)
FAILURE_PHASES = frozenset(
    {"assertion_failure", "import_failure", "teardown_failure", "execution_failure", "cleanup_error"}
)


@dataclass(frozen=True)
class Interpreter:
    path: str
    version: str
    version_info: tuple[int, int, int]
    implementation: str
    executable: str


@dataclass
class ModuleResult:
    module: str
    module_path: str
    phase: str
    exit_code: int | None
    duration_ms: int
    data_root: str
    import_roots: list[str]
    import_provenance: dict[str, str | None] = field(default_factory=dict)
    stdout: str = ""
    stderr: str = ""
    failure_id: str | None = None
    baseline_match: bool = False
    cleanup_errors: list[str] = field(default_factory=list)


def _canonical(path: Path) -> Path:
    return Path(os.path.realpath(os.path.abspath(str(path))))


def _is_within(path: Path, parent: Path) -> bool:
    try:
        _canonical(path).relative_to(_canonical(parent))
    except ValueError:
        return False
    return True


def _probe_interpreter(path: Path) -> Interpreter:
    """Ask the selected executable for its own identity, never ambient Python."""
    script = (
        "import json,platform,sys; print(json.dumps({"
        "'version':platform.python_version(),"
        "'version_info':list(sys.version_info[:3]),"
        "'implementation':platform.python_implementation(),"
        "'executable':sys.executable}))"
    )
    try:
        probe_env = os.environ.copy()
        for key in ("PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE"):
            probe_env.pop(key, None)
        raw = subprocess.run(
            [str(path), "-I", "-B", "-c", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
            env=probe_env,
        ).stdout.strip()
        identity = json.loads(raw)
        parts = tuple(int(value) for value in identity["version_info"])
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError(f"selected Python is not runnable: {path}: {exc}") from exc
    if not (SUPPORTED_MIN <= parts < SUPPORTED_MAX):
        raise ValueError(
            f"unsupported Python {identity['version']} at {path}; "
            f"supported versions are {SUPPORTED_MIN[0]}.x through "
            f"before {SUPPORTED_MAX[0]}.x"
        )
    return Interpreter(
        path=str(_canonical(path)),
        version=identity["version"],
        version_info=parts,
        implementation=identity["implementation"],
        executable=identity["executable"],
    )


def select_interpreter(repo_root: Path, requested: str | None = None) -> Interpreter:
    """Select an explicit supported system or bundled interpreter."""
    candidates: list[Path] = []
    if requested:
        requested_path = Path(requested)
        # A command name is resolved by PATH; a relative path is explicitly a
        # path inside the selected checkout, never relative to the caller.
        if requested_path.is_absolute() or requested_path.parent != Path("."):
            candidates.append(requested_path if requested_path.is_absolute() else repo_root / requested_path)
        elif requested_path.stem.lower() in {"python", "python3", "py"}:
            candidates.append(requested_path)
        else:
            candidates.append(repo_root / requested_path)
    else:
        configured = os.environ.get("ORGTREE_V2_PYTHON")
        if configured:
            candidates.append(Path(configured))
        candidates.append(repo_root / "engine" / "runtime" / "python.exe")
        candidates.append(Path(sys.executable))
        found = shutil.which("python")
        if found:
            candidates.append(Path(found))

    seen: set[str] = set()
    errors: list[str] = []
    for candidate in candidates:
        if not candidate.is_absolute() and not candidate.exists():
            resolved = shutil.which(str(candidate))
            if resolved:
                candidate = Path(resolved)
        candidate = _canonical(candidate)
        if str(candidate).casefold() in seen or not candidate.is_file():
            continue
        seen.add(str(candidate).casefold())
        try:
            return _probe_interpreter(candidate)
        except ValueError as exc:
            errors.append(str(exc))
    detail = "; ".join(errors) or "no candidate executable exists"
    raise ValueError(f"no supported Python interpreter found: {detail}")


def import_roots(repo_root: Path) -> list[Path]:
    """Return the only checkout roots made visible to child imports."""
    return [repo_root, repo_root / "engine" / "backend"]


def _protected_roots() -> list[Path]:
    names = (
        "ORGTREE_DATA", "ORGTREE_AGENT_PARENT_DATA", "ORGTREE_AGENT_LEGACY_DATA",
        "ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT", "ORGTREE_V2_DATA", "ORGTREE_V2_PROFILE",
    )
    roots = []
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            roots.append(_canonical(Path(value)))
    return roots


def make_data_root(repo_root: Path, requested: str | None) -> tuple[Path, bool]:
    """Create a parent for private module roots and say whether it is temporary."""
    if requested:
        base = _canonical(Path(requested))
        if any(_is_within(base, protected) or _is_within(protected, base) for protected in _protected_roots()):
            raise ValueError(f"data root overlaps a protected production root: {base}")
        if _is_within(base, repo_root):
            raise ValueError(f"data root must be outside the checkout: {base}")
        base.mkdir(parents=True, exist_ok=True)
        run_root = base / f"orgtree-verification-{uuid.uuid4().hex}"
        run_root.mkdir()
        return run_root, False
    run_root = Path(tempfile.mkdtemp(prefix="orgtree-verification-"))
    if _is_within(run_root, repo_root):
        raise RuntimeError("temporary verification root unexpectedly overlaps checkout")
    return run_root, True


def _module_name(path: Path, repo_root: Path) -> str:
    try:
        return path.relative_to(repo_root).as_posix()
    except ValueError:
        return path.name


def _classify_failure(exit_code: int | None, stdout: str, stderr: str, marker: str | None = None) -> str:
    text = f"{stdout}\n{stderr}"
    # unittest reports tearDownModule/tearDownClass failures as SystemExit(1),
    # which otherwise looks exactly like an assertion failure.
    # Do not match ordinary test names such as ``test_teardown_failure``;
    # require unittest's error label or a traceback frame.
    if re.search(r"(?:ERROR:.*tearDown|(?:File .*|in )tear[_]?Down|Exception ignored in:.*atexit)", text):
        return "teardown_failure"
    if marker in {"skip", "assertion_failure", "import_failure", "teardown_failure", "execution_failure"}:
        return marker
    if exit_code == 5 or re.search(r"\bSKIP(?:PED)?\b", text, re.IGNORECASE):
        return "skip"
    if re.search(r"(?:AssertionError|^FAIL:|^FAILED)", text, re.MULTILINE):
        return "assertion_failure"
    if re.search(r"(?:ModuleNotFoundError|ImportError)", text):
        return "import_failure"
    return "execution_failure" if exit_code not in (None, 0) else "pass"


def _baseline_ids(path: str | None) -> set[str]:
    if not path:
        return set()
    source = json.loads(Path(path).read_text(encoding="utf-8"))
    values: Any = source.get("failures", source) if isinstance(source, dict) else source
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise ValueError("baseline must be a JSON list of exact failure IDs or {\"failures\": [...]} ")
    return set(values)


def _child_script() -> str:
    # The child writes no files except through the selected module.  The final
    # line is a small protocol so exception phase is not inferred from counts.
    return textwrap.dedent(
        """
        import importlib.util, json, os, runpy, sys, traceback
        from pathlib import Path
        from unittest import SkipTest

        roots = [Path(item).resolve() for item in json.loads(os.environ["ORGTREE_VERIFY_IMPORT_ROOTS"])]
        sys.path[:] = [str(item) for item in roots] + [item for item in sys.path if item not in {"", os.getcwd()}]
        module = os.environ["ORGTREE_VERIFY_MODULE"]
        result = {"phase": "pass", "marker": None, "import_provenance": {}}
        for name in ("engine", "orgtree"):
            spec = importlib.util.find_spec(name)
            result["import_provenance"][name] = str(spec.origin) if spec and spec.origin else None
        try:
            runpy.run_path(module, run_name="__main__")
        except SkipTest:
            result["phase"] = "skip"
            result["marker"] = "skip"
        except AssertionError:
            result["phase"] = "assertion_failure"
            result["marker"] = "assertion_failure"
            traceback.print_exc()
        except (ImportError, ModuleNotFoundError):
            result["phase"] = "import_failure"
            result["marker"] = "import_failure"
            traceback.print_exc()
        except SystemExit as exc:
            code = exc.code if isinstance(exc.code, int) else 1
            result["marker"] = "skip" if code == 5 else ("assertion_failure" if code else "pass")
            result["phase"] = result["marker"]
        except BaseException:
            result["phase"] = "execution_failure"
            result["marker"] = "execution_failure"
            traceback.print_exc()
        print("__ORGTREE_VERIFY_RESULT__" + json.dumps(result), flush=True)
        raise SystemExit(0 if result["phase"] in {"pass", "skip"} else 1)
        """
    )


def _parse_child(stdout: str) -> tuple[str | None, str, dict[str, str | None]]:
    marker = "__ORGTREE_VERIFY_RESULT__"
    lines = stdout.splitlines()
    protocol = next((line[len(marker):] for line in reversed(lines) if line.startswith(marker)), None)
    if protocol is None:
        return None, stdout, {}
    try:
        payload = json.loads(protocol)
        return payload.get("marker"), "\n".join(line for line in lines if not line.startswith(marker)), payload.get("import_provenance", {})
    except json.JSONDecodeError:
        return None, stdout, {}


def _cleanup(path: Path) -> list[str]:
    try:
        shutil.rmtree(path)
    except OSError as exc:
        return [f"{path}: {exc}"]
    return []


def run_modules(
    modules: Sequence[str],
    *,
    repo_root: Path,
    interpreter: Interpreter,
    data_root: Path,
    import_root_paths: Sequence[Path] | None = None,
    baseline: set[str] | None = None,
    timeout: float = 300.0,
) -> list[ModuleResult]:
    roots = [Path(item).resolve() for item in (import_root_paths or import_roots(repo_root))]
    baseline = baseline or set()
    results: list[ModuleResult] = []
    for module in modules:
        path = _canonical(Path(module) if Path(module).is_absolute() else repo_root / module)
        label = _module_name(path, repo_root)
        private_root = data_root / uuid.uuid4().hex
        private_root.mkdir(parents=True)
        env = os.environ.copy()
        # These are process-local controls.  Production devguard remains
        # unchanged; inherited roots and import settings cannot leak to child.
        for key in (
            "PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "ORGTREE_DATA", "ORGTREE_V2_DATA",
            "ORGTREE_V2_PROFILE", "ORGTREE_AGENT_PARENT_DATA", "ORGTREE_AGENT_LEGACY_DATA",
            "ORGTREE_V1_ROOT", "ORGTREE_V1_DATA_ROOT",
        ):
            env.pop(key, None)
        home = private_root / "home"
        home.mkdir()
        env.update(
            {
                "ORGTREE_DATA": str(private_root),
                "ORGTREE_VERIFY_IMPORT_ROOTS": json.dumps([str(item) for item in roots]),
                "ORGTREE_VERIFY_MODULE": str(path),
                "PYTHONNOUSERSITE": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
                "HOME": str(home),
                "USERPROFILE": str(home),
            }
        )
        started = time.monotonic()
        try:
            completed = subprocess.run(
                [interpreter.path, "-I", "-B", "-c", _child_script()],
                cwd=str(repo_root),
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            stdout = completed.stdout
            marker, clean_stdout, provenance = _parse_child(stdout)
            phase = _classify_failure(completed.returncode, clean_stdout, completed.stderr, marker)
            exit_code = completed.returncode
        except subprocess.TimeoutExpired as exc:
            stdout = (exc.stdout or "") if isinstance(exc.stdout, str) else ""
            clean_stdout = stdout
            provenance = {}
            phase = "execution_failure"
            exit_code = None
            completed = None
            stderr = f"module timed out after {timeout:g}s"
        except OSError as exc:
            clean_stdout = ""
            provenance = {}
            phase = "execution_failure"
            exit_code = None
            completed = None
            stderr = str(exc)
        else:
            stderr = completed.stderr
        duration = int((time.monotonic() - started) * 1000)
        failure_id = f"{label}:{phase}" if phase in FAILURE_PHASES else None
        result = ModuleResult(
            module=label,
            module_path=str(path),
            phase=phase,
            exit_code=exit_code,
            duration_ms=duration,
            data_root=str(private_root),
            import_roots=[str(item) for item in roots],
            import_provenance=provenance,
            stdout=clean_stdout[-65536:],
            stderr=stderr[-65536:],
            failure_id=failure_id,
            baseline_match=failure_id in baseline if failure_id else False,
        )
        result.cleanup_errors = _cleanup(private_root)
        if result.cleanup_errors:
            result.phase = "cleanup_error"
            result.failure_id = f"{label}:cleanup_error"
            result.baseline_match = result.failure_id in baseline
        results.append(result)
    return results


def _receipt(repo_root: Path, interpreter: Interpreter, data_root: Path, roots: Sequence[Path], results: Sequence[ModuleResult], baseline: set[str], cleanup_errors: Sequence[str] = ()) -> dict[str, Any]:
    unexpected = [result.failure_id for result in results if result.failure_id and not result.baseline_match]
    return {
        "schema": SCHEMA,
        "checkout_root": str(_canonical(repo_root)),
        "engine_root": str(_canonical(repo_root / "engine")),
        "import_roots": [str(_canonical(root)) for root in roots],
        "data_root": str(_canonical(data_root)),
        "cleanup_errors": list(cleanup_errors),
        "interpreter": asdict(interpreter),
        "baseline_failure_ids": sorted(baseline),
        "modules": [asdict(result) for result in results],
        "summary": {
            "total": len(results),
            "passed": sum(result.phase == "pass" for result in results),
            "skipped": sum(result.phase == "skip" for result in results),
            "failures": sum(bool(result.failure_id) for result in results),
            "unexpected_failures": unexpected,
            "cleanup_errors": len(cleanup_errors),
        },
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("modules", nargs="+", help="Python module/script paths, relative to --repo-root")
    parser.add_argument("--repo-root", default=".", help="checkout containing the selected engine")
    parser.add_argument("--python", dest="python_path", help="explicit supported Python executable")
    parser.add_argument("--data-root", help="dedicated parent for temporary module data roots")
    parser.add_argument("--baseline", help="JSON list of exact failure IDs to tolerate")
    parser.add_argument("--json-output", help="also write the complete receipt to this path")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--keep-data", action="store_true", help="retain the run parent for inspection")
    args = parser.parse_args(argv)

    repo_root = _canonical(Path(args.repo_root))
    interpreter = select_interpreter(repo_root, args.python_path)
    run_root, temporary = make_data_root(repo_root, args.data_root)
    roots = import_roots(repo_root)
    baseline = _baseline_ids(args.baseline)
    try:
        results = run_modules(args.modules, repo_root=repo_root, interpreter=interpreter, data_root=run_root, import_root_paths=roots, baseline=baseline, timeout=args.timeout)
        cleanup_errors: list[str] = []
        if temporary and not args.keep_data:
            cleanup_errors = _cleanup(run_root)
        receipt = _receipt(repo_root, interpreter, run_root, roots, results, baseline, cleanup_errors)
        if cleanup_errors:
            receipt["summary"]["unexpected_failures"].extend(f"run:cleanup_error:{error}" for error in cleanup_errors)
        print(json.dumps(receipt, indent=2, sort_keys=True))
        if args.json_output:
            Path(args.json_output).write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return 1 if receipt["summary"]["unexpected_failures"] else 0
    finally:
        # The normal path removes the run root before producing the receipt so
        # any cleanup error affects the exit status.  If receipt construction
        # itself fails, still make a best effort to close the temporary root.
        if temporary and not args.keep_data and run_root.exists():
            _cleanup(run_root)


if __name__ == "__main__":
    raise SystemExit(main())
