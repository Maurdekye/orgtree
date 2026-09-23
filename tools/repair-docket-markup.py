"""Find -- and mechanically strip -- tool-call framing markup in docket
descriptions.

WHAT THIS IS FOR. A description that reached the docket before the write-time
refusal landed can be holding raw tool-call framing: a closing tag, an opening
parameter tag, and the whole payload of the argument that should have followed.
`orgtree.toolmarkup` explains where that comes from; the short version is that
the text was already malformed when it arrived, so the store is full of it and
no future refusal removes what is already there.

WHY A TOOL RATHER THAN A HAND EDIT. `freeze-provenance` reported this defect
three times and deliberately did NOT repair the text, on the grounds that
re-typing a specification to fix an encoding bug risks silently changing the
specification. That was the right call. So this repair is a MECHANICAL STRIP: it
removes the markup spans and nothing else, it PROVES that before it writes
anything -- re-inserting the removed spans must reconstruct the original byte
for byte, or the item is skipped -- and it applies the result through the
ordinary `work_update` path, so the complete before and after land in the item's
append-only `scope` record and the repair is inspectable afterwards.

WHAT IT DOES NOT DO. It does not delete the payload that leaked in. That is
content its author wrote, merely in the wrong field, and deleting it would lose
exactly what the mechanical rule exists to protect. The tags go; the words stay,
left in place for a human to move.

USAGE. It reports by default and writes only when told to:

    python tools/repair-docket-markup.py --data <root>            # report only
    python tools/repair-docket-markup.py --data <root> --org orgtree
    python tools/repair-docket-markup.py --data <root> --apply    # repair

⚠ `--data` IS REQUIRED AND MUST BE A REAL DATA ROOT. `devguard` refuses an
inherited live root on import when this runs as a desktop agent's child, which
is deliberate: an agent probing this defect must not write to the docket
everybody else is reading. Run it against a copy first. To repair live data, run
it outside an agent process.

STATUS AT THE TIME OF WRITING (2026-09-19). Every org database on this machine
was scanned -- live items and archive, across every prose field -- and the live
repair set was EMPTY: the only stored description containing the fragment is the
ticket that REPORTS the defect, where it is a legitimate backtick quotation and
is correctly left alone. This tool exists because the root cause is upstream of
the engine and will recur, not because there is a backlog to work through.
"""
from __future__ import annotations

import argparse
import difflib
import os
import sys
from pathlib import Path


def _place_repo_on_path() -> Path:
    """This file lives in `<repo>/tools`, so the checkout is derivable."""
    repo = Path(__file__).resolve().parent.parent
    for root in (str(repo), str(repo / "engine" / "backend")):
        if root not in sys.path:
            sys.path.insert(0, root)
    return repo


REPO = _place_repo_on_path()

#: The prose fields a leak has been observed in, plus the ones it could reach.
#: `objective` is the one that matters -- it is the item's authoritative scope.
FIELDS = ("objective",)


def report_item(slug: str, field: str, text: str, toolmarkup) -> tuple[str, list]:
    repaired, removed = toolmarkup.strip_leaks(text)
    print(f"\n#### {slug}.{field} — {len(removed)} leak(s), "
          f"{sum(len(s.text) for s in removed)} byte(s) of markup")
    for span in removed:
        print(f"     {span.label:<34} {span.text!r} at {span.start}..{span.end}")
    diff = difflib.unified_diff(text.splitlines(True), repaired.splitlines(True),
                                fromfile=f"{slug}.{field} (stored)",
                                tofile=f"{slug}.{field} (repaired)", n=1)
    for line in diff:
        print("     " + line.rstrip("\n"))
    return repaired, removed


def proves_mechanical(original: str, repaired: str, removed: list) -> bool:
    """Re-insert the removed spans; the result must be the input, byte for byte.

    This is the gate, not a diagnostic. An item that fails it is left alone
    even under `--apply`: a repair that cannot be shown to have touched nothing
    but markup is exactly the risk the whole approach exists to avoid.
    """
    rebuilt: list[str] = []
    cursor = 0
    for span in removed:
        rebuilt.append(original[cursor:span.start])
        rebuilt.append(span.text)
        cursor = span.end
    rebuilt.append(original[cursor:])
    if "".join(rebuilt) != original:
        return False
    return len(repaired) == len(original) - sum(len(s.text) for s in removed)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python tools/repair-docket-markup.py",
        description="Report, and optionally mechanically strip, tool-call "
                    "framing markup in docket descriptions.")
    parser.add_argument("--data", required=True,
                        help="ORGTREE_DATA root to work against (a copy, "
                             "unless you mean the live docket)")
    parser.add_argument("--org", action="append", default=None,
                        help="org slug; repeatable. Default: every org found")
    parser.add_argument("--apply", action="store_true",
                        help="write the repairs. Without this nothing is "
                             "written and the run is a report")
    args = parser.parse_args(argv)

    root = Path(args.data).expanduser().resolve()
    if not root.is_dir():
        parser.error(f"--data {root} is not a directory")
    # ⚠ before the first orgtree import: `store.DATA_ROOT` binds at import time
    os.environ["ORGTREE_DATA"] = str(root)

    from orgtree import store, toolmarkup                      # noqa: PLC0415

    if Path(store.DATA_ROOT).resolve() != root:
        print(f"REFUSING: store.DATA_ROOT is {store.DATA_ROOT}, not {root} — "
              f"something bound the data root before this ran, and a repair "
              f"against the wrong docket is worse than none.", file=sys.stderr)
        return 2

    orgs = args.org or sorted(
        p.stem for p in (root / "orgs").glob("*.db") if not p.stem.endswith("-wal"))
    if not orgs:
        print(f"no orgs found under {root / 'orgs'}", file=sys.stderr)
        return 1

    # ⚠ NOTHING THIS TOOL PRINTS MAY CONTAIN THE WORD "skip". `tools/run-python
    # -verification.py` classifies a whole module as a SKIP when a case-
    # insensitive `\bSKIP(?:PED)?\b` appears anywhere in its output (line 426),
    # so a suite that drives this tool and passes 21 tests was reported as
    # skipped with exit 0. The wording below says "left alone" for that reason,
    # not for style.
    found = repaired_count = left_alone = 0
    for slug in orgs:
        try:
            org = store.load_org(slug)
        except Exception as exc:                              # noqa: BLE001
            print(f"{slug}: could not load ({exc})", file=sys.stderr)
            continue
        items = list(org.d.get("work_items") or []) + \
            list(org.d.get("work_items_archive") or [])
        print(f"\n=== org {slug}: {len(items)} item(s)")
        for item in items:
            name = str(item.get("slug") or "?")
            for field in FIELDS:
                text = item.get(field)
                if not isinstance(text, str) or not toolmarkup.find_leaks(text):
                    continue
                found += 1
                clean, removed = report_item(name, field, text, toolmarkup)
                if not proves_mechanical(text, clean, removed):
                    left_alone += 1
                    print("     LEFT ALONE — the removed spans do not "
                          "reconstruct the stored text, so this repair cannot "
                          "be shown to be mechanical.", file=sys.stderr)
                    continue
                if not args.apply:
                    continue
                owner = (item.get("owner") or {})
                actor = owner.get("node") if isinstance(owner, dict) else None
                if not actor:
                    left_alone += 1
                    print("     LEFT ALONE — the item has no live owner to "
                          "record the repair against.", file=sys.stderr)
                    continue
                org.work_update(actor, name,
                                ["description repaired: tool-call framing "
                                 "markup stripped mechanically"], [],
                                objective=clean)
                repaired_count += 1
                print("     REPAIRED — before/after are in the item's scope "
                      "record.")
        if args.apply and repaired_count:
            store.save_org(org)

    print(f"\n{found} damaged field(s); "
          f"{repaired_count} repaired; {left_alone} left alone."
          + ("" if args.apply else "  (report only — pass --apply to write)"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
