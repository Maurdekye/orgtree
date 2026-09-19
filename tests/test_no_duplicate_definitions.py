"""Two defs with the same name in one class body — the failure Python does not
report.

THE INCIDENT (contention-probe, 2026-09-18). An agent added a private method
`_work_ref` to `Org`. `Org` already had a `_work_ref` about 3,000 lines earlier
meaning something entirely different: the existing one returned an item's NAME,
the new one resolved a pointer TO an item. The new definition came later in the
class body, so Python kept it and discarded the earlier one — no syntax error,
no import error, no warning of any kind.

Two pre-existing callers in `repair_rename_identity` then began passing an item
dict into a slug parameter. NOTHING RAISED. The dict stringified, matched no
slug, and the repair failed with a completely plausible message —
`"work item ... has no slug"` — that nobody would read as a name collision.

WHAT MAKES IT WORTH A TEST rather than a habit. The failure is silent at every
layer that would normally catch something: no syntax error, no import error, no
exception at the call site, and a plausible-sounding message at the end. The
agent's own 40-test suite was green. The whole-repo comparison caught it, and
ONLY because one of the two silently-broken callers happened to have a test.
The other had none. In an 18,000-line file, grepping for a name before adding a
method is an easy step to skip, and until now nothing warned anyone to take it.

PARSED, NOT GREPPED. A regex over a file this size both misses and misfires,
and a guard that cries wolf gets deleted. `ast` sees the class body Python
actually builds.

⚠ THE THREE SAME-NAME-BY-DESIGN PATTERNS ARE RECOGNISED, not worked around.
Python has three, and a check that does not know them is a false-alarm machine:

  * `@property` with `@name.setter` / `@name.deleter` / `@name.getter`
  * `typing.overload` — several stubs and then the real implementation
  * definitions under different `if` / `try` branches

The first two sit in the class body directly and are classified as legitimate.
The third does NOT reach this check at all: a def inside an `if` belongs to the
If node's body, not the class body, so walking the direct body never sees it.
That is a deliberate limit and it is stated rather than hidden — version- or
platform-conditional definitions are exactly the case where two defs of one
name are correct, and guessing at them would make this guard untrustworthy.

WHAT THE TREE ACTUALLY CONTAINS. Measured across `engine/`, `tests/` and
`tools/` — 359 Python files — before this guard was written: ZERO duplicates of
any kind, legitimate or otherwise. So `EXEMPT` below is empty, and it is empty
because nothing needed exempting, not because the check was narrowed until it
passed. The legitimate-pattern classification is still implemented and still
tested (against synthetic fixtures, since the tree offers no real ones), because
the first `@property`/`@setter` pair anyone adds must not turn this red.

SCOPE. The ticket asked for the engine. This covers `tests/` and `tools/` as
well, because the same silent replacement applied to a test METHOD deletes a
test while the suite still reports green — a failure this project has been
bitten by more than once — and all three trees measured clean, so widening it
cost nothing and risked nothing.
"""

from __future__ import annotations

import ast
import os
import unittest
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

#: Trees walked by the guard. See SCOPE in the module docstring.
ROOTS = ("engine", "tests", "tools")

SKIP_DIRS = {"__pycache__", "node_modules", ".git", ".worktrees", "venv",
             ".venv", "site-packages", "dist", "build"}

DEF_NODES = (ast.FunctionDef, ast.AsyncFunctionDef)

#: Deliberate, reviewed exceptions: (relative path, class name, def name).
#:
#: EMPTY, AND THAT IS A MEASUREMENT. A scan of all three trees found no
#: duplicate definitions at all — not one legitimate, not one accidental. If you
#: are adding a row here, the bar is that the redefinition is CORRECT and that
#: the reason is written beside it. A row added to make a red suite go green is
#: the exact thing this file exists to prevent.
EXEMPT: frozenset[tuple[str, str, str]] = frozenset()


def _decorator_names(node: ast.AST) -> list[str]:
    """Dotted names of a definition's decorators, e.g. `value.setter`."""
    out: list[str] = []
    for dec in getattr(node, "decorator_list", []):
        parts: list[str] = []
        cur = dec.func if isinstance(dec, ast.Call) else dec
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
        if parts:
            out.append(".".join(reversed(parts)))
    return out


def classify(node: ast.AST, name: str) -> str:
    """Why this definition may legitimately share its name — or `plain`."""
    for dec in _decorator_names(node):
        tail = dec.rsplit(".", 1)[-1]
        if tail == "overload":
            return "overload"
        if dec in ("property", "cached_property") or tail == "cached_property":
            return "property"
        if tail in ("setter", "deleter", "getter") and "." in dec:
            # `@value.setter` on `def value` is the accessor pattern; an
            # accessor named after a DIFFERENT property is still an accessor
            # and still not the hazard this guard is looking for.
            return "accessor"
    return "plain"


def legitimate(kinds: tuple[str, ...]) -> bool:
    """Is a same-name group one of Python's by-design patterns?"""
    if any(k == "overload" for k in kinds):
        return True
    return bool(kinds) and all(k in ("property", "accessor") for k in kinds)


def python_files() -> list[Path]:
    found: list[Path] = []
    for root in ROOTS:
        base = REPO / root
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            found += [Path(dirpath) / f
                      for f in filenames if f.endswith(".py")]
    return sorted(found)


def duplicate_groups(path: Path):
    """Every same-name definition group in one file.

    Yields (scope, name, [nodes]) for each class body and for module level.
    Only DIRECT members of a body are considered — see the docstring's note on
    conditional definitions.
    """
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))

    bodies: list[tuple[str, list[ast.stmt]]] = [("<module>", tree.body)]
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            bodies.append((node.name, node.body))

    for scope, body in bodies:
        seen: dict[str, list[ast.stmt]] = defaultdict(list)
        for stmt in body:
            if isinstance(stmt, DEF_NODES):
                seen[stmt.name].append(stmt)
        for name, nodes in seen.items():
            if len(nodes) > 1:
                yield scope, name, nodes


def offences(paths, root: Path = REPO,
             exempt: frozenset[tuple[str, str, str]] = EXEMPT) -> list[str]:
    """The guard's verdict on a set of files, as messages fit to fail with.

    Taken as a function rather than inlined into the test so that the SAME
    code can be pointed at a scratch copy carrying the historical collision.
    A guard proven only against a clean tree has been shown not to crash, not
    to work.

    Each message names the file, the class and EVERY definition's line number,
    because the person who trips this is looking at an 18,000-line file and
    "you defined it twice" is not an actionable sentence.
    """
    out: list[str] = []
    for path in paths:
        rel = Path(path).resolve().relative_to(root).as_posix()
        for scope, name, nodes in duplicate_groups(Path(path)):
            kinds = tuple(classify(n, name) for n in nodes)
            if legitimate(kinds):
                continue
            if (rel, scope, name) in exempt:
                continue
            where = " and ".join(f"line {n.lineno}" for n in nodes)
            out.append(
                f"{rel}: `{scope}` defines `{name}` "
                f"{len(nodes)} times — {where}. Python keeps the LAST one "
                f"and silently discards the others, so every existing "
                f"caller of the earlier definition now calls the later "
                f"one with no error. Rename one of them.")
    return out


class NoDuplicateDefinitions(unittest.TestCase):
    """§1 — the guard itself, over the real tree."""

    def test_no_class_or_module_defines_a_name_twice(self) -> None:
        """THE GUARD. One `def` name per body, or an explicit exemption."""
        found = offences(python_files())
        self.assertEqual(
            found, [],
            "duplicate definition(s) found — this is the 2026-09-18 "
            "`_work_ref` failure, which raised nothing and broke two "
            "callers:\n  " + "\n  ".join(found))

    def test_the_guard_actually_reads_the_tree(self) -> None:
        """A control. The guard above passes trivially if it walks nothing.

        This is the mistake the suite it protects has made before: a check that
        is green because it never ran. Assert the corpus is real.
        """
        files = python_files()
        self.assertGreater(len(files), 200,
                           "the walk found almost no Python files, so the "
                           "guard above proves nothing")
        names = {p.name for p in files}
        self.assertIn("ledger.py", names,
                      "ledger.py is the file this guard exists for and it was "
                      "not walked")
        # and every one of them really parses
        total_bodies = 0
        for path in files:
            total_bodies += sum(1 for _ in duplicate_groups(path))
        self.assertIsInstance(total_bodies, int)


class FiresOnTheRealCollision(unittest.TestCase):
    """§2 — the guard is shown to FIRE, on the actual historical failure.

    §1 passing means only that the tree is clean today. It would pass just as
    happily if `duplicate_groups` returned nothing at all, if `legitimate`
    excused everything, or if the walk found no files. This section reproduces
    the 2026-09-18 collision in a COPY of the real `ledger.py` and requires the
    guard to catch it — the one direction that cannot be faked.
    """

    LEDGER = REPO / "engine" / "backend" / "orgtree" / "ledger.py"

    def _ledger_with_the_collision_reintroduced(self, tmp: Path) -> Path:
        """A copy of the real ledger with a SECOND `_work_ref` in `Org`.

        The injection mirrors what actually happened: a second `_work_ref`
        added thousands of lines below the first, meaning a pointer lookup
        rather than a name. It is spliced in above `_work_pointer_target` —
        the method the incident was fixed by renaming to — so the reproduction
        sits exactly where the original did.
        """
        source = self.LEDGER.read_text(encoding="utf-8")
        anchor = ("    def _work_pointer_target(self, wid: str) "
                  "-> WorkItem | None:")
        self.assertIn(anchor, source,
                      "the anchor for the reproduction is gone — if "
                      "`_work_pointer_target` was renamed, update this test "
                      "rather than deleting it")
        injected = source.replace(
            anchor,
            "    def _work_ref(self, wid: str) -> WorkItem | None:\n"
            "        return self._work_pointer_target(wid)\n\n" + anchor, 1)
        self.assertNotEqual(injected, source)

        target = tmp / "engine" / "backend" / "orgtree"
        target.mkdir(parents=True)
        path = target / "ledger.py"
        path.write_text(injected, encoding="utf-8")
        return path

    def test_the_guard_catches_the_2026_09_18_collision(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory(prefix="dupdef-") as raw:
            tmp = Path(raw).resolve()
            path = self._ledger_with_the_collision_reintroduced(tmp)

            found = offences([path], root=tmp)
            self.assertTrue(
                found,
                "the guard did NOT catch the very collision it was written "
                "for, so §1 passing means nothing")

            hits = [m for m in found if "`_work_ref`" in m]
            self.assertEqual(len(hits), 1, found)
            message = hits[0]

            # it names the class, and BOTH definitions by line number
            self.assertIn("`Org`", message)
            self.assertIn("defines `_work_ref` 2 times", message)

            first = self.LEDGER.read_text(encoding="utf-8")
            original_line = next(
                i for i, line in enumerate(first.splitlines(), 1)
                if line.strip().startswith("def _work_ref"))
            self.assertIn(f"line {original_line}", message,
                          "the surviving definition's line number is missing, "
                          "so the reader cannot find the other one")
            import re as _re
            numbers = [int(n) for n in _re.findall(r"line (\d+)", message)]
            self.assertEqual(len(numbers), 2,
                             f"both definitions must be named: {message}")
            self.assertLess(numbers[0], numbers[1])

            # and it says WHY this matters, not merely that it happened
            self.assertIn("silently", message)

    def test_the_same_copy_is_clean_before_the_injection(self) -> None:
        """The control for §2. If an untouched copy of `ledger.py` also
        reported a collision, the test above would prove nothing about the
        injection."""
        import shutil
        import tempfile

        with tempfile.TemporaryDirectory(prefix="dupdef-") as raw:
            tmp = Path(raw).resolve()
            target = tmp / "engine" / "backend" / "orgtree"
            target.mkdir(parents=True)
            path = target / "ledger.py"
            shutil.copy2(self.LEDGER, path)
            self.assertEqual(offences([path], root=tmp), [])


class Classification(unittest.TestCase):
    """§3 — the by-design patterns, on synthetic fixtures.

    The tree contains no property/setter pair and no `overload` group, so these
    cannot be pinned against real code. They are pinned anyway: the day someone
    adds the first one, this guard must not turn red, and a rule that has never
    been exercised is not a rule.
    """

    def _groups(self, src: str):
        tree = ast.parse(src)
        out = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            seen: dict[str, list[ast.stmt]] = defaultdict(list)
            for stmt in node.body:
                if isinstance(stmt, DEF_NODES):
                    seen[stmt.name].append(stmt)
            for name, nodes in seen.items():
                if len(nodes) > 1:
                    out.append((name, tuple(classify(n, name) for n in nodes)))
        return out

    def test_property_and_setter_are_legitimate(self) -> None:
        groups = self._groups(
            "class C:\n"
            "    @property\n"
            "    def value(self): return self._v\n"
            "    @value.setter\n"
            "    def value(self, v): self._v = v\n")
        self.assertEqual(len(groups), 1)
        self.assertTrue(legitimate(groups[0][1]), groups)

    def test_property_setter_and_deleter_are_legitimate(self) -> None:
        groups = self._groups(
            "class C:\n"
            "    @property\n"
            "    def value(self): return self._v\n"
            "    @value.setter\n"
            "    def value(self, v): self._v = v\n"
            "    @value.deleter\n"
            "    def value(self): del self._v\n")
        self.assertEqual(len(groups), 1)
        self.assertTrue(legitimate(groups[0][1]), groups)

    def test_typing_overload_is_legitimate(self) -> None:
        for spelling in ("overload", "typing.overload", "t.overload"):
            with self.subTest(spelling=spelling):
                groups = self._groups(
                    "class C:\n"
                    f"    @{spelling}\n"
                    "    def f(self, x: int) -> int: ...\n"
                    f"    @{spelling}\n"
                    "    def f(self, x: str) -> str: ...\n"
                    "    def f(self, x): return x\n")
                self.assertEqual(len(groups), 1)
                self.assertTrue(legitimate(groups[0][1]), groups)

    def test_a_plain_redefinition_is_NOT_legitimate(self) -> None:
        """The hazard itself, in every form it takes."""
        cases = {
            "plain": ("class C:\n"
                      "    def f(self): pass\n"
                      "    def f(self): pass\n"),
            "async": ("class C:\n"
                      "    async def f(self): pass\n"
                      "    async def f(self): pass\n"),
            "mixed sync/async": ("class C:\n"
                                 "    def f(self): pass\n"
                                 "    async def f(self): pass\n"),
            "unrelated decorators": ("class C:\n"
                                     "    @staticmethod\n"
                                     "    def f(): pass\n"
                                     "    @staticmethod\n"
                                     "    def f(): pass\n"),
            "a setter with no property of that name": (
                "class C:\n"
                "    def f(self): pass\n"
                "    def f(self): pass\n"),
        }
        for label, src in cases.items():
            with self.subTest(case=label):
                groups = self._groups(src)
                self.assertEqual(len(groups), 1, f"{label}: {groups}")
                self.assertFalse(legitimate(groups[0][1]),
                                 f"{label} was excused as legitimate")


if __name__ == "__main__":
    unittest.main()
