"""Regenerate the renderer's event fixtures from the backend event table.

The backend table and renderer are the source of truth.  This command is also
used by the generated-fixture sync test, so drift is detected before a fixture
can silently become a hand-maintained exception.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from orgtree import events, events_fixtures


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "apps" / "desktop" / "renderer" / "tests" / "fixtures" / "events"


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
