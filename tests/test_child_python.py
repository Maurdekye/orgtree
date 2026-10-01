"""tests/child_python.py: a child Python imports THIS checkout's engine or refuses.

child-python-tests-import-the-main-checkout-s-or: the packaged interpreter's
``python313._pth`` drops PYTHONPATH and cwd, so a child told to use this
checkout through them silently imported the main checkout's engine.
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import import_provenance  # noqa: F401  asserts orgtree resolves inside this checkout
import child_python

CHECKOUT = child_python.CHECKOUT


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, timeout=60, **kw)


def inside(path, root=CHECKOUT):
    path, root = os.path.normcase(os.path.realpath(path)), os.path.normcase(os.path.realpath(root))
    return path.startswith(root + os.sep)


class ChildPython(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='child-python-'))

    def test_code_child_imports_this_checkout_and_keeps_its_argv(self):
        out = run(child_python.argv(
            '-c', 'import sys, orgtree, engine; print(orgtree.__file__); print(engine.__file__); '
                  'print(sys.argv[1:])', 'one', 'two'))
        self.assertEqual(out.returncode, 0, out.stderr)
        orgtree_file, engine_file, argv = out.stdout.splitlines()
        self.assertTrue(inside(orgtree_file), orgtree_file)
        self.assertTrue(inside(engine_file), engine_file)
        self.assertEqual(argv, "['one', 'two']")

    def test_script_child_gets_its_folder_and_argv(self):
        (self.tmp / 'sibling.py').write_text('VALUE = 41\n', encoding='utf-8')
        script = self.tmp / 'child.py'
        script.write_text('import sys, sibling, orgtree\n'
                          'print(sibling.VALUE + 1, sys.argv[1:], orgtree.__file__)\n', encoding='utf-8')
        out = run(child_python.argv(str(script), 'seed', flags=('-B',)))
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("42 ['seed']", out.stdout)
        self.assertTrue(inside(out.stdout.split()[-1]), out.stdout)

    def test_module_child_runs_from_this_checkout(self):
        out = run(child_python.argv('-m', 'tools.migration_harness', '--help',
                                    guarded=child_python.GUARDED + ('tools.migration_harness',)),
                  cwd=self.tmp)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('--scenario', out.stdout)

    def test_exit_status_and_devguard_style_children_pass_through(self):
        self.assertEqual(run(child_python.argv('-c', 'raise SystemExit(7)')).returncode, 7)
        # The check resolves with find_spec, so nothing is imported for the
        # child: a child that expects `import orgtree` to be refused still can.
        out = run(child_python.argv('-c', 'import sys; print(sorted(m for m in ("orgtree", "engine") '
                                          'if m in sys.modules))'))
        self.assertEqual(out.stdout.strip(), '[]', out.stderr)

    def test_a_foreign_checkout_is_refused_before_the_child_runs(self):
        # A checkout with no engine of its own: orgtree can only come from
        # somewhere else (the interpreter's ._pth or site), which is the defect.
        out = run(child_python.argv('-c', 'print("CHILD RAN")', checkout=self.tmp))
        self.assertEqual(out.returncode, child_python.EXIT_FOREIGN, out.stdout + out.stderr)
        self.assertNotIn('CHILD RAN', out.stdout)
        self.assertIn('OUTSIDE the checkout under test before the child ran', out.stderr)

    def test_a_foreign_import_during_the_child_is_refused_at_exit(self):
        fake = self.tmp / 'elsewhere' / 'orgtree'
        fake.mkdir(parents=True)
        (fake / '__init__.py').write_text('', encoding='utf-8')
        code = ('import sys; sys.path.insert(0, sys.argv[1]); '
                'sys.modules.pop("orgtree", None); import orgtree; print("CHILD RAN")')
        out = run(child_python.argv('-c', code, str(fake.parent)))
        self.assertIn('CHILD RAN', out.stdout)
        self.assertEqual(out.returncode, child_python.EXIT_FOREIGN, out.stderr)
        self.assertIn('by the time the child finished', out.stderr)

    def test_control_the_bare_interpreter_ignores_pythonpath(self):
        """The mechanism itself: with a ._pth beside the interpreter, PYTHONPATH
        is not read, so it cannot have been what placed a checkout."""
        if not list(Path(sys.executable).parent.glob('python*._pth')):
            self.skipTest('this interpreter has no ._pth file; PYTHONPATH is honoured here')
        env = dict(os.environ, PYTHONPATH=str(self.tmp))
        out = run([sys.executable, '-c', 'import sys; print(sys.flags.ignore_environment, '
                                         'any(p.rstrip("/\\\\") == sys.argv[1] for p in sys.path))',
                   str(self.tmp)], env=env)
        self.assertEqual(out.stdout.split(), ['1', 'False'], out.stderr)


if __name__ == '__main__':
    unittest.main()
