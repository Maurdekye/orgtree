"""The import-provenance guard: a foreign engine must fail, loudly and by name.

`PYTHONPATH` on a developer machine with the desktop app installed points at
the SHIPPED backend, so a bare `python -m unittest tests.test_x` imports the
installed build rather than the working tree.  The dangerous direction is the
quiet one: a green run reported as a verified fix against code that never
contained the change.

These tests prove the guard's four properties: it refuses an engine resolved
outside the checkout, the refusal names both the foreign path and the canonical
runner, a package that is simply absent is NOT its problem, and the checkout it
measures against is the tree the file lives in -- which is what makes it correct
from a linked worktree and not only from the main checkout.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout

from import_provenance import (CHECKOUT_ROOT, GUARDED, ForeignImportError,
                               assert_repo_import, origin_of)


class ForeignImportIsRefused(unittest.TestCase):
    """A package resolved outside the checkout raises rather than returning."""

    def setUp(self) -> None:
        self.outside = Path(tempfile.mkdtemp(prefix="orgtree-foreign-engine-"))
        self.addCleanup(self._remove)
        package = self.outside / "orgtree_foreign_fixture"
        package.mkdir()
        (package / "__init__.py").write_text("VALUE = 'shipped'\n", encoding="utf-8")
        sys.path.insert(0, str(self.outside))
        self.addCleanup(lambda: sys.path.remove(str(self.outside)))
        sys.modules.pop("orgtree_foreign_fixture", None)
        self.addCleanup(lambda: sys.modules.pop("orgtree_foreign_fixture", None))

    def _remove(self) -> None:
        import shutil
        shutil.rmtree(self.outside, ignore_errors=True)

    def test_a_package_outside_the_checkout_raises(self):
        with self.assertRaises(ForeignImportError):
            assert_repo_import("orgtree_foreign_fixture")

    def test_the_message_names_the_foreign_path_and_the_runner(self):
        with self.assertRaises(ForeignImportError) as caught:
            assert_repo_import("orgtree_foreign_fixture")
        message = str(caught.exception)
        # The failure is the whole value of this guard: an agent that hits it
        # should change one command, not open an investigation.
        self.assertIn(str(self.outside), message)
        self.assertIn(str(CHECKOUT_ROOT), message)
        self.assertIn("tools/run-python-verification.py", message)
        self.assertIn("PYTHONPATH", message)
        self.assertIn("orgtree_foreign_fixture", message)

    def test_it_refuses_rather_than_repairing_sys_path(self):
        """Silently making a bare run work would recreate the original defect."""
        before = list(sys.path)
        with self.assertRaises(ForeignImportError):
            assert_repo_import("orgtree_foreign_fixture")
        self.assertEqual(before, sys.path)

    def test_a_foreign_package_already_imported_is_caught_too(self):
        """The imported module wins over prospective resolution."""
        import orgtree_foreign_fixture  # noqa: F401
        with self.assertRaises(ForeignImportError):
            assert_repo_import("orgtree_foreign_fixture")


class LegitimateImportsPass(unittest.TestCase):
    def test_the_real_engine_resolves_inside_this_checkout(self):
        origins = assert_repo_import()
        self.assertEqual(sorted(origins), sorted(GUARDED))
        for name, origin in origins.items():
            self.assertIsNotNone(origin, f"{name} did not resolve at all")
            self.assertTrue(
                os.path.normcase(str(origin)).startswith(os.path.normcase(str(CHECKOUT_ROOT))),
                f"{name} resolved to {origin}, outside {CHECKOUT_ROOT}",
            )

    def test_an_absent_package_is_not_this_guards_problem(self):
        """A missing import already fails loudly on its own line."""
        self.assertIsNone(origin_of("orgtree_this_package_does_not_exist"))
        self.assertEqual(
            {"orgtree_this_package_does_not_exist": None},
            assert_repo_import("orgtree_this_package_does_not_exist"),
        )


class CheckoutRootFollowsTheWorktree(unittest.TestCase):
    """Why this works from `.worktrees/<name>` and not only from the checkout."""

    def test_the_root_is_derived_from_the_guards_own_location(self):
        self.assertEqual(CHECKOUT_ROOT, Path(import_provenance.__file__).resolve().parents[1])

    def test_the_root_is_not_taken_from_the_working_directory(self):
        elsewhere = Path(tempfile.mkdtemp(prefix="orgtree-elsewhere-"))
        previous = os.getcwd()
        try:
            os.chdir(elsewhere)
            self.assertEqual(CHECKOUT_ROOT, Path(import_provenance.__file__).resolve().parents[1])
            assert_repo_import()
        finally:
            os.chdir(previous)
            import shutil
            shutil.rmtree(elsewhere, ignore_errors=True)

    def test_a_sibling_checkouts_engine_would_be_refused(self):
        """A worktree that imported the MAIN checkout's engine is still wrong."""
        sibling = Path(tempfile.mkdtemp(prefix="orgtree-sibling-checkout-"))
        try:
            package = sibling / "engine" / "backend" / "orgtree_sibling_fixture"
            package.mkdir(parents=True)
            (package / "__init__.py").write_text("", encoding="utf-8")
            sys.path.insert(0, str(package.parent))
            try:
                with self.assertRaises(ForeignImportError):
                    assert_repo_import("orgtree_sibling_fixture")
            finally:
                sys.path.remove(str(package.parent))
                sys.modules.pop("orgtree_sibling_fixture", None)
        finally:
            import shutil
            shutil.rmtree(sibling, ignore_errors=True)


class EveryTestModuleCarriesTheGuard(unittest.TestCase):
    """The guard is only a mechanism if no module is exempt from it."""

    def test_every_test_module_imports_the_guard(self):
        missing = [
            path.name
            for path in sorted((CHECKOUT_ROOT / "tests").glob("test_*.py"))
            if "import import_provenance" not in path.read_text(encoding="utf-8")
        ]
        # If you are reading this because you just added a test module: this is
        # the one line it is missing, and the message is the whole fix.
        self.assertEqual(
            [], missing,
            "These test modules carry no import-provenance guard, so running one "
            "of them with a bare `python` would silently test the INSTALLED app "
            "instead of your working tree. Add this line to each, after any "
            "sys.path.insert and before the first `from orgtree import ...`:\n\n"
            "    import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout\n\n"
            "Missing in: " + ", ".join(missing),
        )

    def test_the_guard_precedes_every_engine_import(self):
        """After any sys.path.insert, before the first `from orgtree import`."""
        import ast

        late = []
        for path in sorted((CHECKOUT_ROOT / "tests").glob("test_*.py")):
            source = path.read_text(encoding="utf-8")
            guard = next(
                index
                for index, line in enumerate(source.splitlines(), start=1)
                if line.startswith("import import_provenance")
            )
            for node in ast.walk(ast.parse(source, filename=str(path))):
                root = None
                if isinstance(node, ast.Import):
                    root = node.names[0].name.split(".")[0]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    root = node.module.split(".")[0]
                if root in GUARDED and node.lineno < guard:
                    late.append(f"{path.name}:{node.lineno}")
        self.assertEqual(
            [], late,
            "The guard is imported AFTER the engine in these modules, so the "
            "engine is already resolved by the time it runs. Move the "
            "`import import_provenance` line above the first `orgtree`/`engine` "
            "import (but below any sys.path.insert). Offenders: " + ", ".join(late),
        )


class ThePackageAliasMakesOneLineWorkEverywhere(unittest.TestCase):
    """`tests/__init__.py` covers the modes `runpy.run_path` does not."""

    def test_importing_the_tests_package_publishes_the_flat_name(self):
        source = (CHECKOUT_ROOT / "tests" / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("import_provenance", source)
        self.assertIn('sys.modules.setdefault("import_provenance"', source)

    def test_the_package_import_runs_the_check(self):
        import tests  # noqa: F401  this is the package-mode entry point

        self.assertIn("import_provenance", sys.modules)


class TheGuardLineIsUnchangedAcrossModules(unittest.TestCase):
    """One identical line, so there is nothing to drift."""

    def test_all_modules_use_the_same_wording(self):
        lines = {
            line
            for path in sorted((CHECKOUT_ROOT / "tests").glob("test_*.py"))
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.startswith("import import_provenance")
        }
        self.assertEqual(1, len(lines), f"guard line wording diverged: {lines}")


if __name__ == "__main__":
    unittest.main()
