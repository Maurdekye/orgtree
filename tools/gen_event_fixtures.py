"""Regenerate the renderer's event fixtures from the backend event table.

The backend table and renderer are the source of truth.  This command is also
used by the generated-fixture sync test, so drift is detected before a fixture
can silently become a hand-maintained exception.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "engine" / "backend"
FIXTURE_DIR = ROOT / "apps" / "desktop" / "renderer" / "tests" / "fixtures" / "events"
sys.path.insert(0, str(BACKEND_ROOT))


def _assert_local_origin(origin: Path | None) -> None:
    try:
        if origin is None:
            raise ValueError
        origin.relative_to(BACKEND_ROOT)
    except ValueError as exc:
        raise RuntimeError(
            "refusing to run: orgtree must resolve below "
            f"{BACKEND_ROOT}, got {origin or '(no origin)'}"
        ) from exc


def _require_local_orgtree() -> None:
    spec = importlib.util.find_spec("orgtree")
    origin = Path(spec.origin).resolve() if spec and spec.origin else None
    _assert_local_origin(origin)


_require_local_orgtree()
from orgtree import events, events_fixtures  # noqa: E402


def fixture_text(variant: str) -> str:
    """Return the canonical JSON fixture for one declared event variant."""
    source = events_fixtures.FIXTURES[variant]
    event = events.mint(variant, source["actor"], source["object"], **source["fields"])
    fixture: dict[str, Any] = {
        "variant": variant,
        "family": events.FAMILY_OF[variant],
        "private": events.encode_ev(event),
        "public": events.public_event(event),
        "body": events.render_agent(event),
    }
    return json.dumps(fixture, indent=2, ensure_ascii=False) + "\n"


def mismatches() -> list[str]:
    """Return fixture names whose checked-in bytes differ from the generator."""
    result: list[str] = []
    for variant in events.VARIANTS:
        path = FIXTURE_DIR / f"{variant}.json"
        expected = fixture_text(variant)
        actual = path.read_text(encoding="utf-8") if path.is_file() else None
        if actual is None or actual.replace("\r\n", "\n") != expected:
            result.append(variant)
    return result


def regenerate() -> None:
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    for variant in events.VARIANTS:
        (FIXTURE_DIR / f"{variant}.json").write_text(
            fixture_text(variant), encoding="utf-8"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report drift without writing files")
    args = parser.parse_args()
    drift = mismatches()
    if args.check:
        if drift:
            print("drift: " + ", ".join(drift))
            return 1
        print("event fixtures are in sync")
        return 0
    regenerate()
    print(f"regenerated {len(events.VARIANTS)} event fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
