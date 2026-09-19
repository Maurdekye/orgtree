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

⚠ THE FOUR SAME-NAME-BY-DESIGN PATTERNS ARE RECOGNISED, not worked around.
Python has four, and a check that does not know them is a false-alarm machine:

  * `@property` with `@name.setter` / `@name.deleter` / `@name.getter`
  * `typing.overload` — several stubs and then the real implementation
  * `functools.singledispatchmethod` — the base plus its `@name.register`
    implementations, which the documented idiom ALL names `_`, so idiomatic
    single dispatch really does put several `def _` in one class body
  * definitions under different `if` / `try` branches

The first three sit in the class body directly and are classified as
legitimate. The fourth does NOT reach this check at all: a def inside an `if`
belongs to the If node's body, not the class body, so walking the direct body
never sees it. That is a deliberate limit and it is stated rather than hidden —
version- or platform-conditional definitions are exactly the case where two
defs of one name are correct, and guessing at them would make this guard
untrustworthy.

⚠ RECOGNISING THE DECORATORS IS NOT ENOUGH; THE SHAPE HAS TO BE COUNTED. This
file got that wrong twice, in the same way, and both were the hazard wearing
correct-looking decorators:

  * two `@property` of one name, and one `@overload` stub with TWO
    implementations — the later definition silently replacing the earlier;
  * two `@value.setter` of one name (review finding f1) — the second rebuilds
    the property and DISCARDS the first setter function. A flat `accessor`
    classification could not tell that from the by-design `setter` + `deleter`
    pair, which is why `classify` reports the accessor KIND.

So `legitimate` counts: at most one `@property`, at most one accessor of each
kind, at most one non-stub implementation in an overload group. The
false-alarm direction is guarded just as deliberately, because a guard that
cries wolf on textbook `functools` usage is one somebody switches off — and
then every real collision is missed.

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


#: Accessor decorators, by the suffix of `@<something>.<suffix>`.
_ACCESSORS = ("setter", "deleter", "getter")


def classify(node: ast.AST, name: str) -> str:
    """Why this definition may legitimately share its name — or `plain`.

    The accessor kinds are reported SEPARATELY (`accessor:setter` and friends)
    rather than collapsed into one `accessor`. That distinction is the whole
    of finding f1: two `@value.setter` of one name is a silent replacement —
    the second rebuilds the property and discards the first function — and a
    flat `accessor` cannot tell that from the by-design `setter` + `deleter`
    pair. `legitimate` counts the kinds; this has to give it kinds to count.
    """
    for dec in _decorator_names(node):
        tail = dec.rsplit(".", 1)[-1]
        if tail == "overload":
            return "overload"
        if dec in ("property", "cached_property") or tail == "cached_property":
            return "property"
        if tail == "singledispatchmethod" or dec.endswith("singledispatch"):
            return "singledispatch"
        if tail == "register" and "." in dec:
            # `@area.register` — a `functools.singledispatchmethod`
            # implementation. The documented idiom names every one of them
            # `_`, so idiomatic single dispatch puts several `def _` in one
            # class body. See the module docstring's fourth pattern.
            return "dispatch"
        if tail in _ACCESSORS and "." in dec:
            base = dec.rsplit(".", 1)[0]
            if base == name:
                # `@value.setter` on `def value`: this builds THIS name's
                # property from itself, which is the by-design pattern.
                return f"accessor:{tail}"
            # `@other.setter` on `def value` rebinds `value` to a property
            # derived from `other`, so an earlier `value` is DISCARDED. The
            # decorator looks like an accessor and the effect is a
            # replacement, so it is not treated as by-design.
            return "plain"
    return "plain"


def legitimate(kinds: tuple[str, ...]) -> bool:
    """Is a same-name group one of Python's by-design patterns?

    ⚠ IT IS NOT ENOUGH TO SEE THE RIGHT DECORATORS — THE SHAPE HAS TO BE RIGHT
    TOO, and an earlier version of this function got that wrong in both
    directions it could. It asked "does this group contain an overload?" and
    "are these all property-ish?", which excused two genuine collisions:

        @property def value  +  @property def value
            two real definitions, the second silently replacing the first.
            Every decorator looks right; the shape is the hazard.

        @overload def f  +  def f  +  def f
            one stub and TWO implementations. The second implementation wins
            and the first is discarded, exactly as in the incident.

    So the shapes are counted, not merely recognised. An overload group may
    have any number of stubs but AT MOST ONE implementation; a property group
    may have at most one `@property` alongside its accessors.
    """
    if not kinds:
        return False

    if any(k == "overload" for k in kinds):
        # stubs are free; more than one real implementation is a collision
        return sum(1 for k in kinds if k != "overload") <= 1

    if any(k in ("dispatch", "singledispatch") for k in kinds):
        # `functools.singledispatchmethod`: the base plus its registered
        # implementations, which the documented idiom all names `_`. Two
        # `@x.register` for the SAME annotated type would be a real
        # collision, but an ast walk cannot resolve types, so the honest rule
        # is that registered implementations are all fine and only a second
        # BASE is a collision.
        if not all(k in ("dispatch", "singledispatch") for k in kinds):
            return False
        return sum(1 for k in kinds if k == "singledispatch") <= 1

    if all(k == "property" or k.startswith("accessor:") for k in kinds):
        # At most one `@property` — two of them is a plain replacement.
        if sum(1 for k in kinds if k == "property") > 1:
            return False
        # AND at most one accessor OF EACH KIND. `setter` + `deleter` is the
        # by-design pair; `setter` + `setter` is finding f1 — the second
        # rebuilds the property and discards the first function, silently.
        # Counting `accessor` as one bucket could not tell those apart.
        for accessor in _ACCESSORS:
            if sum(1 for k in kinds if k == f"accessor:{accessor}") > 1:
                return False
        # The `@property` bound stays `<= 1` rather than `== 1` on purpose: a
        # body holding only accessors (the property built by other means) is
        # odd but is not a replacement. Note that leniency about the MISSING
        # property never extended to the accessors — that conflation was f1.
        return True

    return False


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
    try:
        tree = ast.parse(source, filename=str(path))
    except SyntaxError as exc:
        # NOT swallowed. A file this guard cannot parse is a file it cannot
        # vouch for, and silently skipping it is how a check keeps reporting
        # green over code it never read. Re-raised with the reason, because
        # the bare traceback says "invalid syntax" without saying that the
        # DUPLICATE-DEFINITION GUARD is what went looking.
        raise AssertionError(
            f"the duplicate-definition guard could not parse "
            f"{path}: {exc}. Either the file is broken, or it uses syntax "
            f"newer than this interpreter ({'.'.join(map(str, __import__('sys').version_info[:3]))}). "
            f"The guard cannot vouch for a file it cannot read, so this is a "
            f"failure rather than a skip.") from exc

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

    def test_an_unparseable_file_fails_rather_than_being_skipped(self) -> None:
        """A file the guard cannot read is one it cannot vouch for.

        Skipping it would be the same defect in miniature: a check reporting
        green over code it never looked at.
        """
        import tempfile

        with tempfile.TemporaryDirectory(prefix="dupdef-") as raw:
            tmp = Path(raw).resolve()
            broken = tmp / "broken.py"
            broken.write_text("class C:\n    def f(self)\n        pass\n",
                              encoding="utf-8")
            with self.assertRaises(AssertionError) as caught:
                offences([broken], root=tmp)
            message = str(caught.exception)
            self.assertIn("could not parse", message)
            self.assertIn("duplicate-definition guard", message,
                          "the failure does not say which check hit it")

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

    def test_the_right_decorators_in_the_wrong_SHAPE_are_not_excused(self) -> None:
        """THE HOLE THAT WAS ACTUALLY IN THIS FILE, found by reading it back.

        Both of these carry decorators that make a group look by-design, and
        both are the real hazard: a definition silently replacing an earlier
        one. An earlier `legitimate()` asked only whether the right decorators
        were PRESENT, and excused both. Recognising a pattern is not the same
        as checking its shape.
        """
        cases = {
            "two @property of one name — the second replaces the first": (
                "class C:\n"
                "    @property\n"
                "    def value(self): return 1\n"
                "    @property\n"
                "    def value(self): return 2\n"),
            "one overload stub and TWO implementations": (
                "from typing import overload\n"
                "class C:\n"
                "    @overload\n"
                "    def f(self, x: int) -> int: ...\n"
                "    def f(self, x): return x\n"
                "    def f(self, x): return x * 2\n"),
            "two @cached_property of one name": (
                "from functools import cached_property\n"
                "class C:\n"
                "    @cached_property\n"
                "    def v(self): return 1\n"
                "    @cached_property\n"
                "    def v(self): return 2\n"),
            # ── review finding f1: the accessor kinds, previously uncounted ──
            "@property with TWO @value.setter — second discards the first": (
                "class C:\n"
                "    @property\n"
                "    def value(self): return self._v\n"
                "    @value.setter\n"
                "    def value(self, v): self._v = v\n"
                "    @value.setter\n"
                "    def value(self, v): self._v = v * 2\n"),
            "@property with TWO @v.getter": (
                "class C:\n"
                "    @property\n"
                "    def v(self): return 1\n"
                "    @v.getter\n"
                "    def v(self): return 2\n"
                "    @v.getter\n"
                "    def v(self): return 3\n"),
            "two @v.deleter of one name": (
                "class C:\n"
                "    @property\n"
                "    def v(self): return 1\n"
                "    @v.deleter\n"
                "    def v(self): pass\n"
                "    @v.deleter\n"
                "    def v(self): pass\n"),
            "an accessor named after a DIFFERENT property rebinds this name": (
                "class C:\n"
                "    @property\n"
                "    def value(self): return 1\n"
                "    @other.setter\n"
                "    def value(self, v): pass\n"),
            "a property group mixed with a plain redefinition": (
                "class C:\n"
                "    @property\n"
                "    def v(self): return 1\n"
                "    @v.setter\n"
                "    def v(self, x): pass\n"
                "    def v(self): return 2\n"),
            # ── the single-dispatch rule has a hazard side too, and it
            # survived the first mutation round because nothing covered it.
            # Registered implementations may repeat; a second BASE may not —
            # the later @singledispatchmethod discards the earlier dispatcher
            # and every registration made against it.
            "two @singledispatchmethod bases of one name": (
                "from functools import singledispatchmethod\n"
                "class C:\n"
                "    @singledispatchmethod\n"
                "    def area(self, s): raise NotImplementedError\n"
                "    @singledispatchmethod\n"
                "    def area(self, s): return 0\n"),
            "a dispatch group mixed with a plain redefinition": (
                "class C:\n"
                "    @area.register\n"
                "    def _(self, s: int): return s\n"
                "    def _(self): return None\n"),
        }
        for label, src in cases.items():
            with self.subTest(case=label):
                groups = self._groups(src)
                self.assertEqual(len(groups), 1, f"{label}: {groups}")
                self.assertFalse(
                    legitimate(groups[0][1]),
                    f"{label} was excused as by-design, but the later "
                    f"definition silently replaces the earlier one")

    def test_the_genuinely_by_design_shapes_still_pass(self) -> None:
        """The other half of the same rule — tightening must not over-tighten.

        A guard that starts failing on correct code is a guard somebody
        deletes, so the shapes that ARE by-design are pinned beside the ones
        that are not.
        """
        cases = {
            "overload stubs with exactly one implementation": (
                "from typing import overload\n"
                "class C:\n"
                "    @overload\n"
                "    def f(self, x: int) -> int: ...\n"
                "    @overload\n"
                "    def f(self, x: str) -> str: ...\n"
                "    def f(self, x): return x\n"),
            "overload stubs with no implementation (stub-file style)": (
                "from typing import overload\n"
                "class C:\n"
                "    @overload\n"
                "    def f(self, x: int) -> int: ...\n"
                "    @overload\n"
                "    def f(self, x: str) -> str: ...\n"),
            "one property with both accessors": (
                "class C:\n"
                "    @property\n"
                "    def v(self): return self._v\n"
                "    @v.setter\n"
                "    def v(self, x): self._v = x\n"
                "    @v.deleter\n"
                "    def v(self): del self._v\n"),
            # DISTINCT accessor kinds, which is the line the counting rule
            # draws: different kinds are fine, a repeated kind is f1.
            "accessors only, property built elsewhere": (
                "class C:\n"
                "    @v.setter\n"
                "    def v(self, x): self._v = x\n"
                "    @v.deleter\n"
                "    def v(self): del self._v\n"),
            # ── review finding f2: the fourth by-design pattern ──
            # The documented idiom names EVERY registered implementation `_`,
            # so textbook single dispatch really does put several `def _` in
            # one class body. A guard that cries wolf on this gets switched
            # off, and then every real collision is missed too.
            "functools.singledispatchmethod with registered implementations": (
                "from functools import singledispatchmethod\n"
                "class C:\n"
                "    @singledispatchmethod\n"
                "    def area(self, s): raise NotImplementedError\n"
                "    @area.register\n"
                "    def _(self, s: int): return s\n"
                "    @area.register\n"
                "    def _(self, s: str): return len(s)\n"),
            "singledispatch registrations without the base in this body": (
                "class C:\n"
                "    @area.register\n"
                "    def _(self, s: int): return s\n"
                "    @area.register\n"
                "    def _(self, s: str): return len(s)\n"),
        }
        for label, src in cases.items():
            with self.subTest(case=label):
                groups = self._groups(src)
                self.assertEqual(len(groups), 1, f"{label}: {groups}")
                self.assertTrue(
                    legitimate(groups[0][1]),
                    f"{label} is correct Python and must not be flagged")

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
            # ⚠ REVIEW FINDING f3: this case used to hold a body with no
            # setter in it at all, byte-identical to "plain" above — so the
            # suite ran one assertion twice under two names and the shape the
            # label promised was never exercised. It was also precisely the
            # shape f1 showed to be EXCUSED, which made the one test claiming
            # to cover it the one test that did not. The same "green because
            # it never ran" failure the control test exists to prevent, a
            # level down.
            "two setters with no property of that name": (
                "class C:\n"
                "    @f.setter\n"
                "    def f(self, v): pass\n"
                "    @f.setter\n"
                "    def f(self, v): pass\n"),
        }
        for label, src in cases.items():
            with self.subTest(case=label):
                groups = self._groups(src)
                self.assertEqual(len(groups), 1, f"{label}: {groups}")
                self.assertFalse(legitimate(groups[0][1]),
                                 f"{label} was excused as legitimate")


if __name__ == "__main__":
    unittest.main()
